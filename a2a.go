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
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// A2ASkill describes a capability declared in an agent's /.well-known/agent-card.json.
type A2ASkill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// AgentCardResult holds the parsed A2A Agent Card for a task sandbox.
type AgentCardResult struct {
	Available   bool       `json:"available"`
	Name        string     `json:"name,omitempty"`
	Description string     `json:"description,omitempty"`
	Version     string     `json:"version,omitempty"`
	URL         string     `json:"url,omitempty"`
	Skills      []A2ASkill `json:"skills,omitempty"`
	RawJSON     string     `json:"rawJson,omitempty"`
	Error       string     `json:"error,omitempty"`
}

// A2ATargetRequest identifies how to reach an actor's HTTP/A2A server.
type A2ATargetRequest struct {
	Endpoint    string            `json:"endpoint"`
	TargetActor string            `json:"targetActor,omitempty"`
	AxProgram   string            `json:"axProgram,omitempty"`
	Scope       []string          `json:"scope,omitempty"`
	TaskName    string            `json:"taskName,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
}

// A2APromptRequest describes an A2A JSON-RPC message/send turn.
type A2APromptRequest struct {
	A2ATargetRequest
	Prompt    string `json:"prompt"`
	ContextID string `json:"contextId,omitempty"`
}

// A2APromptResult holds the response, extracted reply text, and W3C trace ID from an A2A turn.
type A2APromptResult struct {
	OK        bool   `json:"ok"`
	Reply     string `json:"reply"`
	TraceID   string `json:"traceId"`
	ContextID string `json:"contextId"`
	RawJSON   string `json:"rawJson"`
	Error     string `json:"error,omitempty"`
}

func randomTraceHex(nBytes int) string {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return strings.Repeat("a", nBytes*2)
	}
	return hex.EncodeToString(b)
}

func normalizeHTTPBase(endpoint string) string {
	ep := strings.TrimSpace(endpoint)
	if ep == "" {
		return ""
	}
	if !strings.HasPrefix(ep, "http://") && !strings.HasPrefix(ep, "https://") {
		ep = "http://" + ep
	}
	return strings.TrimRight(ep, "/")
}

func parseAgentCardPayload(body []byte) AgentCardResult {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return AgentCardResult{Available: false, Error: err.Error()}
	}
	str := func(k string) string {
		if v, ok := raw[k].(string); ok {
			return v
		}
		return ""
	}
	var skills []A2ASkill
	if arr, ok := raw["skills"].([]any); ok {
		for _, item := range arr {
			if m, ok := item.(map[string]any); ok {
				s := A2ASkill{}
				if id, ok := m["id"].(string); ok {
					s.ID = id
				}
				if nm, ok := m["name"].(string); ok {
					s.Name = nm
				}
				if desc, ok := m["description"].(string); ok {
					s.Description = desc
				}
				if s.Name != "" || s.ID != "" {
					skills = append(skills, s)
				}
			}
		}
	}
	name := str("name")
	if name == "" && len(skills) == 0 && str("protocolVersion") == "" && str("url") == "" {
		return AgentCardResult{Available: false, Error: "not an A2A agent card"}
	}
	return AgentCardResult{
		Available:   true,
		Name:        name,
		Description: str("description"),
		Version:     str("version"),
		URL:         str("url"),
		Skills:      skills,
		RawJSON:     string(body),
	}
}

func extractA2AReplyText(body []byte) string {
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		return strings.TrimSpace(string(body))
	}
	if errObj, ok := doc["error"].(map[string]any); ok {
		if msg, ok := errObj["message"].(string); ok && msg != "" {
			return "Error: " + msg
		}
	}
	var texts []string
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			if role, _ := x["role"].(string); role == "user" {
				return
			}
			if t, ok := x["text"].(string); ok && strings.TrimSpace(t) != "" {
				texts = append(texts, strings.TrimSpace(t))
			}
			for k, child := range x {
				if k == "history" {
					continue
				}
				walk(child)
			}
		case []any:
			for _, item := range x {
				walk(item)
			}
		}
	}
	if res, ok := doc["result"]; ok {
		walk(res)
	} else {
		walk(doc)
	}
	if len(texts) > 0 {
		return strings.Join(texts, "\n\n")
	}
	return strings.TrimSpace(string(body))
}

// ProbeAgentCard fetches /.well-known/agent-card.json via direct/atenet-router HTTP or `ax ssh` fallback.
func (a *App) ProbeAgentCard(req A2ATargetRequest) AgentCardResult {
	base := normalizeHTTPBase(req.Endpoint)
	if base != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/.well-known/agent-card.json", nil)
		if err == nil {
			if req.TargetActor != "" {
				httpReq.Header.Set("ate-target-actor", req.TargetActor)
			}
			resp, doErr := http.DefaultClient.Do(httpReq)
			if doErr == nil {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
				_ = resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					return parseAgentCardPayload(body)
				}
			}
		}
	}

	if req.AxProgram != "" && req.TaskName != "" {
		res := a.shell.Run(RunRequest{
			Program: req.AxProgram,
			Args: append(
				append([]string{}, req.Scope...),
				"ssh",
				req.TaskName,
				"--",
				"sh",
				"-c",
				"wget -qO- http://127.0.0.1:80/.well-known/agent-card.json 2>/dev/null || curl -fsSL http://127.0.0.1:80/.well-known/agent-card.json 2>/dev/null",
			),
			Env: req.Env,
		})
		if res.Status == 0 && strings.TrimSpace(res.Stdout) != "" {
			return parseAgentCardPayload([]byte(res.Stdout))
		}
		return AgentCardResult{Available: false, Error: strings.TrimSpace(res.Stderr)}
	}

	return AgentCardResult{Available: false, Error: "agent card unreachable"}
}

// SendA2APrompt dispatches a JSON-RPC 2.0 message/send request with a W3C traceparent header.
func (a *App) SendA2APrompt(req A2APromptRequest) A2APromptResult {
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return A2APromptResult{OK: false, Error: "prompt is required"}
	}
	traceID := randomTraceHex(16)
	spanID := randomTraceHex(8)
	traceparent := fmt.Sprintf("00-%s-%s-01", traceID, spanID)
	ctxID := strings.TrimSpace(req.ContextID)
	if ctxID == "" {
		ctxID = "ax-central-session"
	}
	msgID := "msg-" + randomTraceHex(6)

	payloadObj := map[string]any{
		"jsonrpc": "2.0",
		"id":      msgID,
		"method":  "message/send",
		"params": map[string]any{
			"message": map[string]any{
				"role":      "user",
				"messageId": msgID,
				"contextId": ctxID,
				"parts": []map[string]any{
					{"kind": "text", "text": prompt},
				},
			},
		},
	}
	payloadBytes, err := json.Marshal(payloadObj)
	if err != nil {
		return A2APromptResult{OK: false, TraceID: traceID, ContextID: ctxID, Error: err.Error()}
	}

	base := normalizeHTTPBase(req.Endpoint)
	if base != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
		httpReq, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, base+"/", bytes.NewReader(payloadBytes))
		if reqErr == nil {
			httpReq.Header.Set("Content-Type", "application/json")
			httpReq.Header.Set("traceparent", traceparent)
			if req.TargetActor != "" {
				httpReq.Header.Set("ate-target-actor", req.TargetActor)
			}
			resp, doErr := http.DefaultClient.Do(httpReq)
			if doErr == nil {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
				_ = resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 300 {
					reply := extractA2AReplyText(body)
					isErr := strings.HasPrefix(reply, "Error: ")
					return A2APromptResult{
						OK:        !isErr,
						Reply:     reply,
						TraceID:   traceID,
						ContextID: ctxID,
						RawJSON:   string(body),
						Error: func() string {
							if isErr {
								return reply
							}
							return ""
						}(),
					}
				}
				return A2APromptResult{
					OK:        false,
					TraceID:   traceID,
					ContextID: ctxID,
					RawJSON:   string(body),
					Error:     fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body))),
				}
			}
		}
	}

	if req.AxProgram != "" && req.TaskName != "" {
		res := a.shell.Run(RunRequest{
			Program: req.AxProgram,
			Args: append(
				append([]string{}, req.Scope...),
				"ssh",
				req.TaskName,
				"--",
				"sh",
				"-c",
				`curl -fsSL -H "Content-Type: application/json" -H "traceparent: $1" --data-binary @- http://127.0.0.1:80/`,
				"sh",
				traceparent,
			),
			Stdin: string(payloadBytes),
			Env:   req.Env,
		})
		if res.Status == 0 {
			body := []byte(res.Stdout)
			reply := extractA2AReplyText(body)
			return A2APromptResult{
				OK:        !strings.HasPrefix(reply, "Error: "),
				Reply:     reply,
				TraceID:   traceID,
				ContextID: ctxID,
				RawJSON:   res.Stdout,
			}
		}
		return A2APromptResult{
			OK:        false,
			TraceID:   traceID,
			ContextID: ctxID,
			Error:     strings.TrimSpace(res.Stderr + " " + res.Stdout),
		}
	}

	return A2APromptResult{
		OK:        false,
		TraceID:   traceID,
		ContextID: ctxID,
		Error:     "A2A endpoint unreachable",
	}
}
