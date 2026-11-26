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

//go:build windows

package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/url"

	"github.com/google/ax/pkg/apis/v1alpha1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// dialAX avoids importing github.com/google/ax/client on Windows because its
// internal/tunnel package currently references Unix-only syscall.Kill/Setpgid.
// Direct ServerURL targets dial over gRPC; kubeconfig tunnel contexts fall back
// cleanly to the ax CLI subprocess on Windows.
func dialAX(_ context.Context, srvURL string, _ AXTarget) (v1alpha1.AXClient, *grpc.ClientConn, error) {
	if srvURL == "" {
		return nil, nil, fmt.Errorf("direct gRPC tunnel dialing requires Unix; falling back to ax CLI")
	}
	u, err := url.Parse(srvURL)
	if err != nil {
		return nil, nil, err
	}
	host := u.Host
	if u.Port() == "" {
		if u.Scheme == "https" {
			host += ":443"
		} else {
			host += ":80"
		}
	}
	creds := insecure.NewCredentials()
	if u.Scheme == "https" {
		creds = credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12})
	}
	conn, err := grpc.NewClient(host, grpc.WithTransportCredentials(creds))
	if err != nil {
		return nil, nil, err
	}
	return v1alpha1.NewAXClient(conn), conn, nil
}
