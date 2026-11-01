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

// Command ax-central is a Wails desktop app for AX: design tasks, watch them
// run, open terminals over ax ssh, manage local kind clusters, and expose AX
// actions as WebMCP tools.
package main

import (
	"embed"
	"fmt"
	"os"
	"runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	appMenu := buildMenu(app)

	err := wails.Run(&options.App{
		Title:     "AX Central",
		Width:     1440,
		Height:    900,
		MinWidth:  1100,
		MinHeight: 700,
		Menu:      appMenu,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 250, G: 249, B: 249, A: 255},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind: []any{
			app,
		},
		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: true,
				HideTitle:                  true,
				HideTitleBar:               false,
				FullSizeContent:            true,
				UseToolbar:                 false,
			},
			Appearance:           mac.DefaultAppearance,
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			About: &mac.AboutInfo{
				Title:   "AX Central",
				Message: fmt.Sprintf("Deploy, design and visualize AX tasks with WebMCP.\nVersion %s", appVersion),
			},
		},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func buildMenu(app *App) *menu.Menu {
	m := menu.NewMenu()
	if runtime.GOOS == "darwin" {
		m.Append(menu.AppMenu())
	}

	fileMenu := m.AddSubmenu("File")
	fileMenu.AddText("New Task Design", keys.CmdOrCtrl("n"), func(_ *menu.CallbackData) {
		app.emitMenu("new-design")
	})
	fileMenu.AddText("Open Manifest…", keys.CmdOrCtrl("o"), func(_ *menu.CallbackData) {
		app.emitMenu("open-manifest")
	})
	fileMenu.AddText("Save Manifest…", keys.CmdOrCtrl("s"), func(_ *menu.CallbackData) {
		app.emitMenu("save-manifest")
	})

	m.Append(menu.EditMenu())

	axMenu := m.AddSubmenu("AX")
	axMenu.AddText("Refresh", keys.CmdOrCtrl("r"), func(_ *menu.CallbackData) {
		app.emitMenu("refresh")
	})
	axMenu.AddText("Create Design", keys.CmdOrCtrl("enter"), func(_ *menu.CallbackData) {
		app.emitMenu("apply")
	})
	axMenu.AddSeparator()

	sections := []struct {
		id    string
		title string
		key   string
	}{
		{"overview", "Activity", "1"},
		{"topology", "Map", "2"},
		{"designer", "Deploy", "3"},
		{"terminal", "Terminal", "4"},
		{"clusters", "Clusters", "5"},
	}
	for _, s := range sections {
		secID := s.id
		axMenu.AddText(s.title, keys.CmdOrCtrl(s.key), func(_ *menu.CallbackData) {
			app.emitMenu("section:" + secID)
		})
	}
	axMenu.AddSeparator()
	axMenu.AddText("Toggle WebMCP Inspector", keys.CmdOrCtrl("i"), func(_ *menu.CallbackData) {
		app.emitMenu("webmcp")
	})
	axMenu.AddText("Settings…", keys.CmdOrCtrl(","), func(_ *menu.CallbackData) {
		app.emitMenu("settings")
	})

	m.Append(menu.WindowMenu())
	return m
}
