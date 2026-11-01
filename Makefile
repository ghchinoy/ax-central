# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# AX Central (Wails v2 + Lit WebComponents + WebMCP). See README.md.

.PHONY: help build wails-build dev run-frontend test test-go test-frontend lint security check smoke-local diagrams screenshots format doctor bootstrap version release-darwin clean

VERSION := $(shell jq -r .info.productVersion wails.json 2>/dev/null || echo 0.1.0)
LDFLAGS := -s -w -X main.appVersion=$(VERSION)

help:
	@echo "make build          - frontend (npm install first) + Go binary (v$(VERSION))"
	@echo "make wails-build    - package native macOS/OS bundle via wails build"
	@echo "make release-darwin - build & zip dist/AX-Central-v$(VERSION)-darwin-arm64.zip + SHA256SUMS"
	@echo "make version        - print current project version ($(VERSION))"
	@echo "make dev            - start Wails live-reload dev session (wails dev)"
	@echo "make run-frontend   - start only Vite dev server"
	@echo "make check          - run all quality gates (lint + security + test)"
	@echo "make test           - Go tests (-race) + frontend Vitest (headless Chromium)"
	@echo "make lint           - gofmt, go vet, golangci-lint, bash -n, tsc, prettier"
	@echo "make security       - npm audit + node-security-audit + Go readability checks"
	@echo "make smoke-local    - run E2E debian:12 task smoke test against local Apple container stack"
	@echo "make diagrams       - render Luminous Graphviz .dot diagrams to light/dark WebP"
	@echo "make screenshots    - capture light/dark WebP UI screenshots via Playwright + cwebp"
	@echo "make format         - gofmt -w + prettier --write"
	@echo "make doctor         - audit ax, ate-local variant, ax-experiments & kind prerequisites"
	@echo "make bootstrap      - install/build missing ate-local & ax-experiments prerequisites"
	@echo "make clean          - remove build artifacts"

frontend/node_modules:
	cd frontend && npm install

build: frontend/node_modules
	cd frontend && npm run build
	go build -ldflags "$(LDFLAGS)" -o ax-central .

wails-build: frontend/node_modules
	wails build -ldflags "$(LDFLAGS)"

version:
	@echo "$(VERSION)"

release-darwin: wails-build
	mkdir -p dist
	ditto -c -k --keepParent "build/bin/AX Central.app" "dist/AX-Central-v$(VERSION)-darwin-arm64.zip"
	cd dist && shasum -a 256 "AX-Central-v$(VERSION)-darwin-arm64.zip" > SHA256SUMS

dev: frontend/node_modules
	wails dev

run-frontend: frontend/node_modules
	cd frontend && npm run dev

test: test-go test-frontend

test-go:
	go vet . && go test -race -count=1 .

test-frontend: frontend/node_modules
	cd frontend && npm test

lint: frontend/node_modules
	@test -z "$$(gofmt -s -l .)" || { gofmt -s -l .; exit 1; }
	go vet .
	@if command -v golangci-lint >/dev/null 2>&1; then golangci-lint run .; fi
	bash -n hack/*.sh docker-shim.sh
	cd frontend && npm run lint

security: frontend/node_modules
	cd frontend && npm audit --audit-level=moderate
	@test -z "$$(grep -nE '\binterface\{\}' *.go)" || { echo "Found interface{} in Go files; use any instead"; exit 1; }

check: lint security test

smoke-local:
	bash hack/smoke-local.sh

diagrams:
	@for f in docs/diagrams/*.dot; do \
		base=$${f%.dot}; \
		gvpr -c -f ../graphviz-style/theme/luminous.gvpr -a light "$$f" | dot -Twebp -o "$${base}-light.webp"; \
		gvpr -c -f ../graphviz-style/theme/luminous.gvpr -a dark  "$$f" | dot -Twebp -o "$${base}-dark.webp"; \
	done

screenshots: frontend/node_modules
	node hack/screenshots.mjs

format: frontend/node_modules
	gofmt -s -w .
	cd frontend && npm run format

doctor:
	bash hack/doctor.sh

bootstrap:
	bash hack/doctor.sh --install all

clean:
	rm -rf ax-central build/bin dist frontend/dist
