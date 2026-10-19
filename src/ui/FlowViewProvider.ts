import { randomBytes } from 'node:crypto'

import * as vscode from 'vscode'

import type { TActionId, TFlowModel } from '../core/types'
import { renderBody, renderDocument } from './render'

type TWebviewMessage = { type: 'open'; path: string } | { type: 'action'; id: TActionId }

export class FlowViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'sddFlow.view'

  private view: vscode.WebviewView | undefined
  private model: TFlowModel = { kind: 'no-workspace' }

  constructor(
    private readonly onOpenPath: (relativePath: string) => void,
    private readonly onAction: (id: TActionId) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.onDidReceiveMessage((message: TWebviewMessage) => {
      if (message.type === 'open') this.onOpenPath(message.path)
      else if (message.type === 'action') this.onAction(message.id)
    })
    view.onDidDispose(() => {
      this.view = undefined
    })
    this.render()
  }

  update(model: TFlowModel): void {
    this.model = model
    this.render()
  }

  private render(): void {
    if (!this.view) return
    const nonce = randomBytes(16).toString('base64')
    this.view.webview.html = renderDocument(renderBody(this.model), nonce, this.view.webview.cspSource)
  }
}
