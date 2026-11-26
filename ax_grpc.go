// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/ax/pkg/apis/v1alpha1"
	ateapipb "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"gopkg.in/yaml.v3"
)

const (
	grpcDialTimeout = 12 * time.Second
	grpcCallTimeout = 15 * time.Second
)

// AXTarget selects the AX server and atespace for direct gRPC calls.
type AXTarget struct {
	ServerURL  string `json:"serverUrl,omitempty"`
	Context    string `json:"context,omitempty"`
	Namespace  string `json:"namespace,omitempty"`
	Atespace   string `json:"atespace,omitempty"`
	Kubeconfig string `json:"kubeconfig,omitempty"`
}

// AXTaskItem is a serialized Task returned by AXListScope.
type AXTaskItem struct {
	Name     string `json:"name"`
	Atespace string `json:"atespace"`
	State    string `json:"state"`
	Actor    string `json:"actor,omitempty"`
	Age      string `json:"age"`
	Manifest string `json:"manifest"`
}

// AXWorkspaceItem is a serialized Workspace returned by AXListScope.
type AXWorkspaceItem struct {
	Name       string `json:"name"`
	Atespace   string `json:"atespace"`
	Phase      string `json:"phase"`
	GitRepos   int    `json:"gitRepos"`
	MCPServers int    `json:"mcpServers"`
	Manifest   string `json:"manifest"`
}

// AXModelItem is a serialized Model returned by AXListScope.
type AXModelItem struct {
	Name       string `json:"name"`
	Atespace   string `json:"atespace"`
	Provider   string `json:"provider"`
	ModelID    string `json:"modelId"`
	SecretName string `json:"secretName,omitempty"`
	SecretKey  string `json:"secretKey,omitempty"`
	Manifest   string `json:"manifest"`
}

// AXGatewaySecretRef identifies a Kubernetes credential Secret referenced by a Gateway rule.
type AXGatewaySecretRef struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Key       string `json:"key"`
	URI       string `json:"uri"`
}

// AXGatewayRule summarizes one outbound allowlist rule on a Gateway.
type AXGatewayRule struct {
	Kind      string   `json:"kind"` // "http" | "https" | "tlsPassthrough"
	Hosts     []string `json:"hosts"`
	Headers   []string `json:"headers,omitempty"`
	SecretURI string   `json:"secretUri,omitempty"`
}

// AXGatewayItem is a serialized Gateway returned by AXListScope.
type AXGatewayItem struct {
	Name       string               `json:"name"`
	Atespace   string               `json:"atespace"`
	Hosts      []string             `json:"hosts"`
	Rules      []AXGatewayRule      `json:"rules"`
	SecretRefs []AXGatewaySecretRef `json:"secretRefs,omitempty"`
	Manifest   string               `json:"manifest"`
}

// AXListSnapshot bundles all resources in an atespace fetched over direct gRPC.
type AXListSnapshot struct {
	OK         bool              `json:"ok"`
	Error      string            `json:"error,omitempty"`
	Tasks      []AXTaskItem      `json:"tasks"`
	Workspaces []AXWorkspaceItem `json:"workspaces"`
	Models     []AXModelItem     `json:"models"`
	Gateways   []AXGatewayItem   `json:"gateways"`
}

// AXActionRequest describes a direct gRPC lifecycle or delete RPC.
type AXActionRequest struct {
	Target AXTarget `json:"target"`
	Kind   string   `json:"kind"`   // "task" | "workspace" | "model" | "gateway"
	Action string   `json:"action"` // "resume" | "suspend" | "delete"
	Name   string   `json:"name"`
}

// AXActionResult is the outcome of AXMutate.
type AXActionResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// axDialer serializes per-context dialing so concurrent UI polls never spawn
// duplicate kubectl port-forward tunnels (adopted from agentexecutor/studio).
type axDialer struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func newAXDialer() *axDialer {
	return &axDialer{locks: make(map[string]*sync.Mutex)}
}

func (d *axDialer) lockFor(key string) *sync.Mutex {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.locks[key]
	if m == nil {
		m = &sync.Mutex{}
		d.locks[key] = m
	}
	return m
}

func normalizeServerURL(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
		return "http://" + s
	}
	return s
}

func (d *axDialer) dial(ctx context.Context, target AXTarget) (v1alpha1.AXClient, *grpc.ClientConn, error) {
	srvURL := normalizeServerURL(target.ServerURL)
	lockKey := srvURL
	if lockKey == "" {
		lockKey = target.Context + "|" + target.Namespace + "|" + target.Kubeconfig
	}
	l := d.lockFor(lockKey)
	l.Lock()
	defer l.Unlock()

	dialCtx, cancel := context.WithTimeout(ctx, grpcDialTimeout)
	defer cancel()

	if target.Kubeconfig != "" && srvURL == "" {
		prev, had := os.LookupEnv("KUBECONFIG")
		_ = os.Setenv("KUBECONFIG", target.Kubeconfig)
		defer func() {
			if had {
				_ = os.Setenv("KUBECONFIG", prev)
			} else {
				_ = os.Unsetenv("KUBECONFIG")
			}
		}()
	}

	return dialAX(dialCtx, srvURL, target)
}

func protoToYAML(msg proto.Message) string {
	raw, err := protojson.MarshalOptions{UseProtoNames: false, EmitUnpopulated: false}.Marshal(msg)
	if err != nil {
		return ""
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return string(raw)
	}
	out, err := yaml.Marshal(generic)
	if err != nil {
		return string(raw)
	}
	return string(out)
}

func formatAge(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := time.Since(t)
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

var ateSecretURIRe = regexp.MustCompile(`ate-secret://k8s\.io/[^/\s"']+/([^/\s"']+)/([^/\s"']+)/([^/\s"']+)`)

func summarizeGateway(gw *v1alpha1.Gateway, manifestYAML string) AXGatewayItem {
	meta := gw.GetMetadata()
	item := AXGatewayItem{
		Name:     meta.GetName(),
		Atespace: meta.GetAtespace(),
		Hosts:    []string{},
		Rules:    []AXGatewayRule{},
		Manifest: manifestYAML,
	}

	hostSet := map[string]struct{}{}
	secretSeen := map[string]struct{}{}

	addRule := func(kind string, hosts []string, effects *ateapipb.HttpRuleEffects) {
		cleanHosts := make([]string, 0, len(hosts))
		for _, h := range hosts {
			if h == "" {
				continue
			}
			cleanHosts = append(cleanHosts, h)
			hostSet[h] = struct{}{}
		}
		rule := AXGatewayRule{Kind: kind, Hosts: cleanHosts}
		for _, rh := range effects.GetReplaceHeaders() {
			if h := rh.GetHeader(); h != "" {
				rule.Headers = append(rule.Headers, h)
			}
			if uri := rh.GetCredentialUri(); uri != "" {
				if rule.SecretURI == "" {
					rule.SecretURI = uri
				}
				if m := ateSecretURIRe.FindStringSubmatch(uri); m != nil {
					if _, seen := secretSeen[uri]; !seen {
						secretSeen[uri] = struct{}{}
						item.SecretRefs = append(item.SecretRefs, AXGatewaySecretRef{
							Namespace: m[1],
							Name:      m[2],
							Key:       m[3],
							URI:       uri,
						})
					}
				}
			}
		}
		sort.Strings(rule.Headers)
		item.Rules = append(item.Rules, rule)
	}

	for _, r := range gw.GetSpec().GetEgress() {
		if https := r.GetHttps(); https != nil {
			addRule("https", https.GetHostnames(), https.GetEffects())
		}
		if http := r.GetHttp(); http != nil {
			addRule("http", http.GetHostnames(), http.GetEffects())
		}
		if tls := r.GetTlsPassthrough(); tls != nil {
			addRule("tlsPassthrough", tls.GetHostnames(), nil)
		}
	}
	for h := range hostSet {
		item.Hosts = append(item.Hosts, h)
	}
	sort.Strings(item.Hosts)
	return item
}

func listAXScope(ctx context.Context, dialer *axDialer, target AXTarget) AXListSnapshot {
	snap := AXListSnapshot{
		Tasks:      []AXTaskItem{},
		Workspaces: []AXWorkspaceItem{},
		Models:     []AXModelItem{},
		Gateways:   []AXGatewayItem{},
	}
	ates := strings.TrimSpace(target.Atespace)
	if ates == "" {
		ates = "default"
	}

	c, conn, err := dialer.dial(ctx, target)
	if err != nil {
		snap.Error = err.Error()
		return snap
	}
	defer func() { _ = conn.Close() }()

	callCtx, cancel := context.WithTimeout(ctx, grpcCallTimeout)
	defer cancel()

	// Paginated ListTasks
	var taskToken string
	for {
		resp, err := c.ListTasks(callCtx, &v1alpha1.ListTasksRequest{
			Atespace:  ates,
			PageSize:  200,
			PageToken: taskToken,
		})
		if err != nil {
			snap.Error = err.Error()
			return snap
		}
		for _, t := range resp.GetTasks() {
			if t.GetApiVersion() == "" {
				t.ApiVersion = "ax.io/v1alpha1"
			}
			if t.GetKind() == "" {
				t.Kind = "Task"
			}
			meta := t.GetMetadata()
			var created time.Time
			if ts := meta.GetCreateTime(); ts != nil {
				created = ts.AsTime()
			}
			snap.Tasks = append(snap.Tasks, AXTaskItem{
				Name:     meta.GetName(),
				Atespace: meta.GetAtespace(),
				State:    t.GetStatus().GetState().String(),
				Actor:    t.GetStatus().GetActor(),
				Age:      formatAge(created),
				Manifest: protoToYAML(t),
			})
		}
		taskToken = resp.GetNextPageToken()
		if taskToken == "" {
			break
		}
	}

	// Paginated ListWorkspaces
	var wsToken string
	for {
		resp, err := c.ListWorkspaces(callCtx, &v1alpha1.ListWorkspacesRequest{
			Atespace:  ates,
			PageSize:  200,
			PageToken: wsToken,
		})
		if err != nil {
			break
		}
		for _, w := range resp.GetWorkspaces() {
			if w.GetApiVersion() == "" {
				w.ApiVersion = "ax.io/v1alpha1"
			}
			if w.GetKind() == "" {
				w.Kind = "Workspace"
			}
			meta := w.GetMetadata()
			mcpCount := len(w.GetSpec().GetMcp().GetServers())
			for _, reg := range w.GetSpec().GetMcp().GetRegistries() {
				mcpCount += len(reg.GetServers())
			}
			snap.Workspaces = append(snap.Workspaces, AXWorkspaceItem{
				Name:       meta.GetName(),
				Atespace:   meta.GetAtespace(),
				Phase:      w.GetStatus().GetPhase(),
				GitRepos:   len(w.GetSpec().GetSetup().GetGit()),
				MCPServers: mcpCount,
				Manifest:   protoToYAML(w),
			})
		}
		wsToken = resp.GetNextPageToken()
		if wsToken == "" {
			break
		}
	}

	// Paginated ListModels
	var modelToken string
	for {
		resp, err := c.ListModels(callCtx, &v1alpha1.ListModelsRequest{
			Atespace:  ates,
			PageSize:  200,
			PageToken: modelToken,
		})
		if err != nil {
			break
		}
		for _, m := range resp.GetModels() {
			if m.GetApiVersion() == "" {
				m.ApiVersion = "ax.io/v1alpha1"
			}
			if m.GetKind() == "" {
				m.Kind = "Model"
			}
			meta := m.GetMetadata()
			sk := m.GetSpec().GetSecretKey()
			snap.Models = append(snap.Models, AXModelItem{
				Name:       meta.GetName(),
				Atespace:   meta.GetAtespace(),
				Provider:   m.GetSpec().GetProvider(),
				ModelID:    m.GetSpec().GetModel(),
				SecretName: sk.GetName(),
				SecretKey:  sk.GetKey(),
				Manifest:   protoToYAML(m),
			})
		}
		modelToken = resp.GetNextPageToken()
		if modelToken == "" {
			break
		}
	}

	// Paginated ListGateways
	var gwToken string
	for {
		resp, err := c.ListGateways(callCtx, &v1alpha1.ListGatewaysRequest{
			Atespace:  ates,
			PageSize:  200,
			PageToken: gwToken,
		})
		if err != nil {
			break
		}
		for _, gw := range resp.GetGateways() {
			if gw.GetApiVersion() == "" {
				gw.ApiVersion = "ax.io/v1alpha1"
			}
			if gw.GetKind() == "" {
				gw.Kind = "Gateway"
			}
			snap.Gateways = append(snap.Gateways, summarizeGateway(gw, protoToYAML(gw)))
		}
		gwToken = resp.GetNextPageToken()
		if gwToken == "" {
			break
		}
	}

	snap.OK = true
	return snap
}

func mutateAXResource(ctx context.Context, dialer *axDialer, req AXActionRequest) AXActionResult {
	ates := strings.TrimSpace(req.Target.Atespace)
	if ates == "" {
		ates = "default"
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return AXActionResult{Error: "resource name is required"}
	}

	c, conn, err := dialer.dial(ctx, req.Target)
	if err != nil {
		return AXActionResult{Error: err.Error()}
	}
	defer func() { _ = conn.Close() }()

	callCtx, cancel := context.WithTimeout(ctx, grpcCallTimeout)
	defer cancel()

	switch strings.ToLower(strings.TrimSpace(req.Kind)) {
	case "task":
		switch strings.ToLower(strings.TrimSpace(req.Action)) {
		case "resume":
			_, err = c.ResumeTask(callCtx, &v1alpha1.ResumeTaskRequest{Atespace: ates, Name: name})
		case "suspend":
			_, err = c.SuspendTask(callCtx, &v1alpha1.SuspendTaskRequest{Atespace: ates, Name: name})
		case "delete":
			_, err = c.DeleteTask(callCtx, &v1alpha1.DeleteTaskRequest{Atespace: ates, Name: name})
		default:
			return AXActionResult{Error: fmt.Sprintf("unsupported task action %q", req.Action)}
		}
	case "workspace":
		if strings.ToLower(strings.TrimSpace(req.Action)) != "delete" {
			return AXActionResult{Error: fmt.Sprintf("unsupported workspace action %q", req.Action)}
		}
		_, err = c.DeleteWorkspace(callCtx, &v1alpha1.DeleteWorkspaceRequest{Atespace: ates, Name: name})
	case "model":
		if strings.ToLower(strings.TrimSpace(req.Action)) != "delete" {
			return AXActionResult{Error: fmt.Sprintf("unsupported model action %q", req.Action)}
		}
		_, err = c.DeleteModel(callCtx, &v1alpha1.DeleteModelRequest{Atespace: ates, Name: name})
	case "gateway":
		if strings.ToLower(strings.TrimSpace(req.Action)) != "delete" {
			return AXActionResult{Error: fmt.Sprintf("unsupported gateway action %q", req.Action)}
		}
		_, err = c.DeleteGateway(callCtx, &v1alpha1.DeleteGatewayRequest{Atespace: ates, Name: name})
	default:
		return AXActionResult{Error: fmt.Sprintf("unsupported resource kind %q", req.Kind)}
	}

	if err != nil {
		return AXActionResult{Error: err.Error()}
	}
	return AXActionResult{OK: true}
}
