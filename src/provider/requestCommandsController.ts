import * as vscode from 'vscode';
import { httpFileStore, HttpRegion, HttpFile, httpYacApi, utils, HttpSymbolKind } from 'httpyac';
import { APP_NAME, getConfigSetting, RESPONSE_VIEW_PRESERVE_FOCUS, RESPONSE_VIEW_PREVIEW } from '../config';
import { errorHandler } from './errorHandler';
import { extension } from 'mime-types';
import { promises as fs } from 'fs';

interface CommandData{
  httpRegion: HttpRegion;
  httpFile: HttpFile
}
export const commands = {
  send: `${APP_NAME}.send`,
  resend: `${APP_NAME}.resend`,
  sendAll:`${APP_NAME}.sendall`,
  clearAll:`${APP_NAME}.clearall`,
  show: `${APP_NAME}.show`,
  viewHeader: `${APP_NAME}.viewHeader`,
  save: `${APP_NAME}.save`
};

export class RequestCommandsController implements vscode.CodeLensProvider {

  subscriptions: Array<vscode.Disposable>;
  onDidChangeCodeLenses: vscode.Event<void>;

  constructor(private readonly refreshCodeLens: vscode.EventEmitter<void>, httpDocumentSelector: vscode.DocumentSelector) {
    this.onDidChangeCodeLenses = refreshCodeLens.event;
    this.subscriptions = [
      vscode.commands.registerCommand(commands.send, this.send, this),
      vscode.commands.registerCommand(commands.clearAll, this.clearAll, this),
      vscode.commands.registerCommand(commands.sendAll, this.sendAll, this),
      vscode.commands.registerCommand(commands.resend, this.resend, this),
      vscode.commands.registerCommand(commands.show, this.show, this),
      vscode.commands.registerCommand(commands.save, this.save, this),
      vscode.commands.registerCommand(commands.viewHeader, this.viewHeader, this),
			vscode.languages.registerCodeLensProvider(httpDocumentSelector, this),
    ];
  }

  dispose() {
    if (this.subscriptions) {
      this.subscriptions.forEach(obj => obj.dispose());
      this.subscriptions = [];
    }
  }

  @errorHandler()
  public provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const httpFile = httpFileStore.get(document.fileName);

    const result: Array<vscode.CodeLens> = [];

    if (httpFile && httpFile.httpRegions.length > 0) {

      result.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        command: commands.sendAll,
        title: 'send all'
      }));

      for (const httpRegion of httpFile.httpRegions) {
        const requestLine = httpRegion.symbol.children?.find(obj => obj.kind === HttpSymbolKind.requestLine)?.startLine || httpRegion.symbol.startLine;
        const range = new vscode.Range(requestLine, 0, httpRegion.symbol.endLine, 0);
        const args = [document, requestLine];

        if (!!httpRegion.request && !httpRegion.metaParams.disabled) {
          result.push(new vscode.CodeLens(range, {
            command: commands.send,
            arguments: args,
            title: 'send'
          }));

        }

        if (httpRegion.response) {
          result.push(new vscode.CodeLens(range, {
            command: commands.show,
            arguments: args,
            title: 'show'
          }));

          result.push(new vscode.CodeLens(range, {
            command: commands.save,
            arguments: args,
            title: 'save'
          }));

          result.push(new vscode.CodeLens(range, {
            command: commands.viewHeader,
            arguments: args,
            title: 'show headers'
          }));
        }
      }
    }
    return Promise.resolve(result);
  }

  private currentRequest: CommandData | undefined;

  @errorHandler()
  async send(document?: vscode.TextDocument, line?: number) {
    this.currentRequest = await this.getCurrentHttpRegion(document, line);
    await this.sendRequest();
  }

  @errorHandler()
  async resend() {
    await this.sendRequest();
  }

  private async sendRequest() {

    if (this.currentRequest) {
      await httpYacApi.send(this.currentRequest.httpRegion, this.currentRequest.httpFile);
      if (this.refreshCodeLens) {
        this.refreshCodeLens.fire();
      }
      await httpYacApi.show(this.currentRequest.httpRegion, this.currentRequest.httpFile);
    }
  }
  @errorHandler()
  async sendAll() {
    const document  = vscode.window.activeTextEditor?.document;
    if (document) {
      const httpFile = await httpFileStore.getOrCreate(document.fileName, () => Promise.resolve(document.getText()), document.version);
      await httpYacApi.sendAll(httpFile);
      if (this.refreshCodeLens) {
        this.refreshCodeLens.fire();
      }
    }
  }

  @errorHandler()
  async clearAll() {
    let document = vscode.window.activeTextEditor?.document;
    if (document) {
      const httpFile = httpFileStore.get(document.fileName);
      if (httpFile) {
        for (const httpRegion of httpFile.httpRegions) {
          delete httpRegion.response;
        }
      }
    }
  }

  @errorHandler()
  async show(document?: vscode.TextDocument, line?: number) {
    const parsedDocument = await this.getCurrentHttpRegion(document, line);
    if (parsedDocument) {
      await httpYacApi.show(parsedDocument.httpRegion, parsedDocument.httpFile);
    }
  }

  @errorHandler()
  async viewHeader(document: vscode.TextDocument | HttpRegion | undefined, line: number | undefined) {
    if (document) {
      let httpRegion: HttpRegion | undefined;
      if (this.isHttpRegion(document)) {
        httpRegion = document;
      } else {
        const parsedDocument = await this.getCurrentHttpRegion(document, line);
        if (parsedDocument) {
          httpRegion = parsedDocument.httpRegion;
        }
      }

      if (httpRegion) {
        const content = utils.toMarkdown(httpRegion);
        const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.Active,
          preserveFocus: getConfigSetting<boolean>(RESPONSE_VIEW_PRESERVE_FOCUS),
          preview: getConfigSetting<boolean>(RESPONSE_VIEW_PREVIEW),
        });
      }
    }
  }

  @errorHandler()
  async save(document?: vscode.TextDocument, line?: number) {
    const parsedDocument = await this.getCurrentHttpRegion(document, line);
    if (parsedDocument && parsedDocument.httpRegion.response) {
      const ext = parsedDocument.httpRegion.metaParams.extension || extension(parsedDocument.httpRegion.response.contentType?.contentType || 'application/octet-stream');
      const filters: Record<string, Array<string>> = {};
      if (ext) {
        filters[ext] = [ext];
      }
      const uri = await vscode.window.showSaveDialog({
        filters
      });
      if (uri) {
        await fs.writeFile(uri.fsPath, new Uint8Array(parsedDocument.httpRegion.response.rawBody));
      }
    }
  }

  private async getCurrentHttpRegion(doc: vscode.TextDocument  | undefined, line: number | undefined) {
    const document = doc || vscode.window.activeTextEditor?.document;
    if (document) {
      const httpFile = await httpFileStore.getOrCreate(document.fileName, () => Promise.resolve(document.getText()), document.version);
      if (httpFile) {
        const currentLine = line ?? vscode.window.activeTextEditor?.selection.active.line;
        if (currentLine !== undefined) {
          const httpRegion = httpFile.httpRegions.find(obj => obj.symbol.startLine <= currentLine && currentLine <= obj.symbol.endLine);
          if (httpRegion) {
            return { httpRegion, httpFile };
          }
        }
      }
    }
    return undefined;
  }

  toString() {
    return 'requestCommandsController';
  }
  isHttpRegion(obj: any): obj is HttpRegion{
    return obj.actions && obj.position;
  }
}
