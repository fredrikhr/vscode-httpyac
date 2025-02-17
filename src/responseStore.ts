import * as vscode from 'vscode';
import * as httpyac from 'httpyac';
import { ResponseHandler, ResponseItem, ResponseStore as IResponseStore } from './extensionApi';
import * as view from './view';
import { DisposeProvider } from './utils';
import { getConfigSetting } from './config';
import { StorageProvider } from './io';

export class ResponseStore extends DisposeProvider implements IResponseStore {
  readonly responseCache: Array<view.ResponseItem> = [];
  private readonly refreshHistory: vscode.EventEmitter<void>;
  private prettyPrintDocuments: Array<vscode.Uri> = [];

  readonly responseHandlers: Array<ResponseHandler>;

  constructor(
    private readonly storageProvider: StorageProvider
  ) {
    super();
    this.responseHandlers = [
      view.saveFileResponseHandler,
      view.noResponseViewResponseHandler,
      view.openWithResponseHandlerFactory(storageProvider),
      view.previewResponseHandlerFactory(storageProvider),
    ];
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(async editor => {
        const indexOfDocument = editor?.document && this.prettyPrintDocuments.indexOf(editor.document.uri) || -1;
        if (editor && indexOfDocument >= 0) {
          await this.prettyPrint(editor);
          this.prettyPrintDocuments.splice(indexOfDocument, 1);
        }
      }),
    ];
    this.refreshHistory = new vscode.EventEmitter<void>();
  }


  get historyChanged(): vscode.Event<void> {
    return this.refreshHistory.event;
  }

  findResponseByDocument(document: vscode.TextDocument): view.ResponseItem | undefined {
    const docUri = document.uri.toString();
    return this.responseCache.find(obj => obj.documentUri?.toString() === docUri);
  }

  findResponseByHttpRegion(httpRegion: httpyac.HttpRegion): view.ResponseItem | undefined {
    return this.responseCache.find(obj => obj.name === httpRegion.symbol.name && obj.line === httpRegion.symbol.startLine);
  }

  public async add(response: httpyac.HttpResponse, httpRegion?: httpyac.HttpRegion): Promise<void> {
    const responseItem = new view.ResponseItem(response, httpRegion);
    await this.show(responseItem);
    this.addToCache(responseItem);
  }


  private shrinkResponseItem(response: httpyac.HttpResponse) {
    delete response.request?.body;
    delete response.parsedBody;
    delete response.body;
    delete response.rawBody;
    delete response.prettyPrintBody;
  }

  private addToCache(responseItem: view.ResponseItem) {
    const config = getConfigSetting();
    this.responseCache.splice(0, 0, responseItem);
    this.responseCache.length = Math.min(this.responseCache.length, config.maxHistoryItems || 50);
    this.refreshHistory.fire();
    vscode.commands.executeCommand('setContext', 'httpyacHistoryEnabled', this.responseCache.length > 0);
  }


  async remove(responseItem: ResponseItem): Promise<boolean> {
    const index = this.responseCache.findIndex(obj => obj.id === responseItem.id);
    if (index >= 0) {
      if (responseItem.responseUri) {
        await this.storageProvider.deleteFile(responseItem.responseUri);
      }
      this.responseCache.splice(index, 1);
      this.refreshHistory.fire();
      if (this.responseCache.length === 0) {
        vscode.commands.executeCommand('setContext', 'httpyacHistoryEnabled', false);
      }
      return true;
    }
    return false;
  }

  async clear(): Promise<void> {
    for (const responseItem of this.responseCache) {
      if (responseItem.responseUri) {
        await this.storageProvider.deleteFile(responseItem.responseUri);
      }
    }
    this.responseCache.length = 0;
    this.refreshHistory.fire();
    vscode.commands.executeCommand('setContext', 'httpyacHistoryEnabled', false);
  }


  public async shrink(responseItem: ResponseItem): Promise<void> {
    const response = responseItem.response;
    if (response.rawBody) {
      const responseUri = responseItem.responseUri || await this.storageProvider.writeFile(response.rawBody, `${responseItem.id}.${responseItem.extension}`);
      if (responseUri) {
        this.shrinkResponseItem(response);
        responseItem.responseUri = responseUri;
        responseItem.isCachedResponse = true;
        responseItem.loadResponseBody = async () => {
          const buffer = await vscode.workspace.fs.readFile(responseUri);
          response.rawBody = Buffer.from(buffer);
          response.body = response.rawBody.toString('utf-8');
          responseItem.isCachedResponse = false;
          delete responseItem.loadResponseBody;
        };
      } else {
        await this.remove(responseItem);
      }
    }
  }

  public async show(responseItem: ResponseItem): Promise<void> {
    for (const responseHandler of this.responseHandlers) {
      const result = await responseHandler(responseItem);
      if (result) {
        if (getConfigSetting().responseViewPrettyPrint && vscode.window.activeTextEditor) {
          await this.prettyPrint(vscode.window.activeTextEditor);
        }
        break;
      }
    }

    await this.shrink(responseItem);
  }

  private async prettyPrint(editor: vscode.TextEditor): Promise<void> {
    if (editor) {
      if (vscode.window.activeTextEditor?.document === editor.document) {
        if (await vscode.commands.executeCommand<boolean>('editor.action.formatDocument', editor)) {
          this.prettyPrintDocuments.push(editor.document.uri);
        }
      } else {
        this.prettyPrintDocuments.push(editor.document.uri);
      }
    }
  }
}
