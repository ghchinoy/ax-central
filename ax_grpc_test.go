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
	"net"
	"sync"
	"testing"

	"github.com/google/ax/pkg/apis/v1alpha1"
	ateapipb "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type fakeAXServer struct {
	v1alpha1.UnimplementedAXServer
	mu      sync.Mutex
	actions []string
}

func (f *fakeAXServer) ListTasks(_ context.Context, req *v1alpha1.ListTasksRequest) (*v1alpha1.ListTasksResponse, error) {
	return &v1alpha1.ListTasksResponse{
		Tasks: []*v1alpha1.Task{{
			Metadata: &v1alpha1.ObjectMeta{
				Name:       "triage-1",
				Atespace:   req.GetAtespace(),
				CreateTime: timestamppb.Now(),
			},
			Spec: &v1alpha1.TaskSpec{
				Profile: &v1alpha1.Profile{Image: "debian:12"},
				Gateway: &v1alpha1.GatewayRef{Name: "gemini-gw"},
				Debug:   true,
			},
			Status: &v1alpha1.TaskStatus{
				State: v1alpha1.TaskState_TASK_STATE_RUNNING,
				Actor: "triage-1",
			},
		}},
	}, nil
}

func (f *fakeAXServer) ListWorkspaces(_ context.Context, req *v1alpha1.ListWorkspacesRequest) (*v1alpha1.ListWorkspacesResponse, error) {
	return &v1alpha1.ListWorkspacesResponse{
		Workspaces: []*v1alpha1.Workspace{{
			Metadata: &v1alpha1.ObjectMeta{Name: "repo-ws", Atespace: req.GetAtespace()},
			Spec: &v1alpha1.WorkspaceSpec{
				Setup: &v1alpha1.WorkspaceSetup{
					Git: []*v1alpha1.GitRepo{{Name: "app", Repo: "https://example.com/app.git"}},
				},
			},
			Status: &v1alpha1.WorkspaceStatus{Phase: "Ready"},
		}},
	}, nil
}

func (f *fakeAXServer) ListModels(_ context.Context, req *v1alpha1.ListModelsRequest) (*v1alpha1.ListModelsResponse, error) {
	return &v1alpha1.ListModelsResponse{
		Models: []*v1alpha1.Model{{
			Metadata: &v1alpha1.ObjectMeta{Name: "gemini-fast", Atespace: req.GetAtespace()},
			Spec: &v1alpha1.ModelSpec{
				Provider:  "google",
				Model:     "gemini-3.8-flash",
				SecretKey: &v1alpha1.SecretKeyRef{Name: "gemini-key", Key: "api-key"},
			},
		}},
	}, nil
}

func (f *fakeAXServer) ListGateways(_ context.Context, req *v1alpha1.ListGatewaysRequest) (*v1alpha1.ListGatewaysResponse, error) {
	return &v1alpha1.ListGatewaysResponse{
		Gateways: []*v1alpha1.Gateway{{
			Metadata: &v1alpha1.ObjectMeta{Name: "gemini-gw", Atespace: req.GetAtespace()},
			Spec: &v1alpha1.GatewaySpec{
				Egress: []*ateapipb.EgressRule{{
					Https: &ateapipb.HttpsRule{
						Hostnames: []string{"generativelanguage.googleapis.com"},
						Effects: &ateapipb.HttpRuleEffects{
							ReplaceHeaders: []*ateapipb.CredentialHeader{{
								Header:        "x-goog-api-key",
								CredentialUri: "ate-secret://k8s.io/default/ax-system/gemini-key/api-key",
							}},
						},
					},
				}},
			},
		}},
	}, nil
}

func (f *fakeAXServer) SuspendTask(_ context.Context, req *v1alpha1.SuspendTaskRequest) (*v1alpha1.Task, error) {
	f.mu.Lock()
	f.actions = append(f.actions, "suspend:"+req.GetAtespace()+"/"+req.GetName())
	f.mu.Unlock()
	return &v1alpha1.Task{Metadata: &v1alpha1.ObjectMeta{Name: req.GetName(), Atespace: req.GetAtespace()}}, nil
}

func (f *fakeAXServer) ResumeTask(_ context.Context, req *v1alpha1.ResumeTaskRequest) (*v1alpha1.Task, error) {
	f.mu.Lock()
	f.actions = append(f.actions, "resume:"+req.GetAtespace()+"/"+req.GetName())
	f.mu.Unlock()
	return &v1alpha1.Task{Metadata: &v1alpha1.ObjectMeta{Name: req.GetName(), Atespace: req.GetAtespace()}}, nil
}

func (f *fakeAXServer) DeleteGateway(_ context.Context, req *v1alpha1.DeleteGatewayRequest) (*emptypb.Empty, error) {
	f.mu.Lock()
	f.actions = append(f.actions, "delete-gw:"+req.GetAtespace()+"/"+req.GetName())
	f.mu.Unlock()
	return &emptypb.Empty{}, nil
}

func TestAXDirectGRPCListAndMutate(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	fake := &fakeAXServer{}
	srv := grpc.NewServer()
	v1alpha1.RegisterAXServer(srv, fake)
	go func() { _ = srv.Serve(lis) }()
	defer srv.Stop()

	app := NewApp()
	target := AXTarget{
		ServerURL: lis.Addr().String(),
		Atespace:  "default",
	}

	snap := app.AXListScope(target)
	if !snap.OK || snap.Error != "" {
		t.Fatalf("AXListScope failed: %+v", snap)
	}
	if len(snap.Tasks) != 1 || snap.Tasks[0].Name != "triage-1" || snap.Tasks[0].State != "TASK_STATE_RUNNING" {
		t.Fatalf("unexpected tasks: %+v", snap.Tasks)
	}
	if len(snap.Workspaces) != 1 || snap.Workspaces[0].GitRepos != 1 {
		t.Fatalf("unexpected workspaces: %+v", snap.Workspaces)
	}
	if len(snap.Models) != 1 || snap.Models[0].SecretName != "gemini-key" {
		t.Fatalf("unexpected models: %+v", snap.Models)
	}
	if len(snap.Gateways) != 1 || snap.Gateways[0].Name != "gemini-gw" {
		t.Fatalf("unexpected gateways: %+v", snap.Gateways)
	}
	if len(snap.Gateways[0].Hosts) != 1 || snap.Gateways[0].Hosts[0] != "generativelanguage.googleapis.com" {
		t.Fatalf("unexpected gateway hosts: %+v", snap.Gateways[0].Hosts)
	}
	if len(snap.Gateways[0].SecretRefs) != 1 || snap.Gateways[0].SecretRefs[0].Name != "gemini-key" || snap.Gateways[0].SecretRefs[0].Key != "api-key" {
		t.Fatalf("unexpected gateway secret refs: %+v", snap.Gateways[0].SecretRefs)
	}

	for _, req := range []AXActionRequest{
		{Target: target, Kind: "task", Action: "suspend", Name: "triage-1"},
		{Target: target, Kind: "task", Action: "resume", Name: "triage-1"},
		{Target: target, Kind: "gateway", Action: "delete", Name: "gemini-gw"},
	} {
		if res := app.AXMutate(req); !res.OK {
			t.Fatalf("AXMutate(%+v) failed: %s", req, res.Error)
		}
	}
	if len(fake.actions) != 3 {
		t.Fatalf("recorded actions = %v, want 3", fake.actions)
	}
}
