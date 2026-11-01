/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { css } from "lit";

export const sharedStyles = css`
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  [hidden] {
    display: none !important;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  input,
  textarea,
  select,
  button {
    font: inherit;
    color: inherit;
  }

  code,
  pre,
  .mono {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .selectable,
  pre,
  code,
  input,
  textarea {
    user-select: text;
  }

  a {
    color: var(--primary);
  }

  a:focus-visible,
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  summary:focus-visible {
    outline: var(--focus);
    outline-offset: 2px;
  }

  /* MARK: Controls (Luminous 0.17–0.19) */

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 13px;
    border-radius: 999px;
    border: 1px solid var(--outline-variant);
    background: var(--surface-bright);
    color: var(--on-surface);
    cursor: pointer;
    white-space: nowrap;
    font-size: 12.5px;
    font-weight: 500;
    transition: transform var(--duration-fast) var(--easing-standard);
  }
  .btn:hover:not(:disabled) {
    background: var(--surface-container-high);
  }
  .btn:active:not(:disabled) {
    transform: scale(0.98);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .btn.primary {
    background: var(--primary);
    border-color: transparent;
    color: var(--on-primary);
    font-weight: 500;
  }
  .btn.primary:hover:not(:disabled) {
    filter: brightness(1.06);
    background: var(--primary);
  }
  .btn.danger {
    color: var(--danger);
  }
  .btn.danger.primary {
    background: var(--danger);
    color: var(--on-danger);
    border-color: transparent;
  }
  .btn.ghost {
    border-color: transparent;
    background: transparent;
    box-shadow: none;
  }
  .btn.ghost:hover:not(:disabled) {
    background: var(--surface-container);
  }
  .btn.icon {
    padding: 0;
    width: 30px;
    justify-content: center;
  }
  .btn.small {
    height: 25px;
    padding: 0 10px;
    font-size: 12px;
  }
  .btn.small.icon {
    width: 25px;
    padding: 0;
  }

  .input,
  .select,
  .textarea {
    height: 30px;
    padding: 0 10px;
    border-radius: var(--radius-s);
    border: 1px solid var(--outline-variant);
    background: var(--surface-bright);
    color: var(--on-surface);
    outline: none;
    min-width: 0;
  }
  .textarea {
    height: auto;
    padding: 8px 10px;
    resize: vertical;
    line-height: 1.45;
  }
  .input:focus,
  .select:focus,
  .textarea:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .input.mono {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .input.invalid {
    border-color: var(--danger);
  }

  /* Luminous 0.17 tonal segmented control */
  .segmented {
    display: inline-grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border-radius: 999px;
    background: var(--surface-dim);
  }
  .segmented button {
    border: 0;
    background: transparent;
    height: 24px;
    padding: 0 12px;
    border-radius: 999px;
    cursor: pointer;
    color: var(--on-surface-variant);
    font-size: 12px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    white-space: nowrap;
    transition: box-shadow var(--duration-fast) var(--easing-standard);
  }
  .segmented button:hover {
    color: var(--on-surface);
    background: var(--state-hover);
  }
  .segmented button.on {
    background: light-dark(
      var(--surface-bright),
      var(--surface-container-highest)
    );
    color: var(--on-surface);
    box-shadow: var(--shadow-1);
    outline: 1px solid light-dark(transparent, var(--on-surface-low));
    outline-offset: -1px;
  }

  .toggle {
    display: inline-block;
    position: relative;
    width: 32px;
    height: 18px;
    flex: none;
    cursor: pointer;
  }
  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
    position: absolute;
  }
  .toggle span {
    position: absolute;
    inset: 0;
    border-radius: 18px;
    background: var(--outline-variant);
    transition: background var(--duration-fast) var(--easing-standard);
  }
  .toggle span::after {
    content: "";
    position: absolute;
    width: 14px;
    height: 14px;
    left: 2px;
    top: 2px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    transition: transform var(--duration-fast) var(--easing-standard);
  }
  .toggle input:checked + span {
    background: var(--primary);
  }
  .toggle input:checked + span::after {
    transform: translateX(14px);
  }

  input[type="range"] {
    accent-color: var(--primary);
  }

  /* MARK: Building blocks */

  .card {
    background: var(--surface-bright);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    box-shadow: var(--shadow-1);
  }
  .card.highlight {
    border-color: var(--tint, var(--primary));
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--tint, var(--primary)) 16%, transparent),
      var(--shadow-1);
  }

  .page {
    height: 100%;
    overflow: auto;
    padding: 24px 28px 32px;
  }
  .page-header {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }
  .page-header h1 {
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 700;
    margin: 0;
    letter-spacing: -0.02em;
  }
  .page-header p {
    margin: 4px 0 0;
    color: var(--on-surface-variant);
    font-size: 13.5px;
  }
  .page-header .spacer {
    flex: 1;
  }

  .muted {
    color: var(--on-surface-variant);
  }
  .faint {
    color: var(--text-3);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .col {
    display: flex;
    flex-direction: column;
  }
  .spacer {
    flex: 1;
  }
  .caption {
    font-size: 11.5px;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .clamp2 {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    height: 22px;
    border-radius: 999px;
    background: var(--surface-container);
    color: var(--on-surface-variant);
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px 2px 7px;
    height: 22px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    white-space: nowrap;
    color: var(--c, var(--on-surface));
    background: color-mix(
      in srgb,
      var(--c, var(--primary)) 12%,
      var(--surface-bright)
    );
  }

  .dotgrid {
    background-color: var(--surface);
    background-image: radial-gradient(var(--grid-dot) 1px, transparent 1px);
    background-size: 18px 18px;
  }

  .pulse {
    position: relative;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c, var(--green));
    flex: none;
  }
  .pulse.on::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: var(--c, var(--green));
    animation: pulse 1.8s ease-out infinite;
  }
  @keyframes pulse {
    from {
      transform: scale(1);
      opacity: 0.6;
    }
    to {
      transform: scale(2.6);
      opacity: 0;
    }
  }

  .spin,
  .spinner {
    animation: lumi-spin 1s linear infinite;
  }
  @keyframes lumi-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin,
    .spinner,
    .pulse.on::after {
      animation: none;
    }
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--on-surface-variant);
    padding: 32px 16px;
    text-align: center;
  }
  .empty svg {
    opacity: 0.6;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    width: min(480px, 92vw);
    padding: 22px;
    border-radius: var(--radius-l);
    box-shadow: var(--shadow-2);
  }
  .modal h3 {
    margin: 0 0 14px;
    font-family: var(--font-display);
    font-size: 17px;
  }

  .fade-in {
    animation: fadein var(--duration-fast) var(--easing-standard);
  }
  @keyframes fadein {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  /* Dropdown menu */
  .dropdown {
    position: relative;
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    min-width: 240px;
    padding: 6px;
    z-index: 60;
    box-shadow: var(--shadow-2);
    max-height: 60vh;
    overflow: auto;
    border-radius: var(--radius-m);
    background: var(--surface-bright);
    border: 1px solid var(--outline-variant);
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 7px 10px;
    border: 0;
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--on-surface);
    cursor: pointer;
    font-size: 13px;
  }
  .menu-item:hover:not(:disabled) {
    background: var(--primary-container);
    color: var(--on-primary-container);
  }
  .menu-item:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .menu-check {
    width: 15px;
    display: inline-flex;
    flex: none;
  }
  .menu-sep {
    height: 1px;
    background: var(--border);
    margin: 4px 6px;
  }
  .menu-heading {
    padding: 4px 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10.5px;
    font-weight: 600;
  }

  /* Console */
  .console {
    flex: 1;
    min-height: 160px;
    display: flex;
    flex-direction: column;
    background: var(--console);
    color: var(--console-text);
  }
  .console.collapsed {
    flex: 0 0 auto;
    min-height: 0;
    margin-top: auto;
  }
  .console-bar {
    padding: 8px 16px;
    gap: 8px;
    font-size: 12px;
    background: var(--console);
    color: #d4d4da;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .console-bar .faint {
    color: #b4b4ba;
  }
  .console-bar.collapsible {
    cursor: pointer;
  }
  .console-bar .btn.ghost {
    color: #d4d4da;
  }
  .console-bar .btn.ghost:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.1);
  }
  .console-body {
    flex: 1;
    overflow: auto;
    padding: 10px 16px 14px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
  }
  .console-line {
    white-space: pre-wrap;
    word-break: break-all;
  }
  .console-line.start {
    color: #8ab4f8;
    font-weight: 600;
    margin-top: 8px;
  }
  .console-line.start:first-child {
    margin-top: 0;
  }
  .console-line.ok {
    color: #6dd58c;
    font-weight: 600;
  }
  .console-line.fail {
    color: #f28b82;
    font-weight: 600;
  }
  .console-empty {
    color: #8e8e93;
    padding-top: 4px;
  }
`;
