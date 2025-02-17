import { Disposable, OutputChannel, window, env } from 'vscode';
import { APP_NAME } from '../config';
import { io, LogLevel, utils } from 'httpyac';


const outputChannels: Record<string, OutputChannel> = {};

export function getOutputChannel(channel: string, show = false): OutputChannel {
  let outputChannel = outputChannels[channel];
  if (!outputChannel) {
    outputChannel = window.createOutputChannel(`${APP_NAME} - ${channel}`);
    if (show) {
      outputChannel.show(true);
    }
    outputChannels[channel] = outputChannel;
  }
  return outputChannel;
}

export async function logStream(channel: string, type: string, message: unknown) : Promise<void> {
  const outputChannel = getOutputChannel(channel, true);
  appendToOutputChannel(outputChannel, [message], `${new Date().toLocaleTimeString()} - ${type}: `);
}

export function logToOuputChannelFactory(channel: string): (level: LogLevel, ...messages: Array<unknown>) => void {
  return function logToOuputChannel(level: LogLevel, ...messages: Array<unknown>) {
    const outputChannel = getOutputChannel(channel);
    outputChannel.append(`${LogLevel[level].toUpperCase()}: `);
    appendToOutputChannel(outputChannel, messages);
  };
}

function appendToOutputChannel(outputChannel: OutputChannel, messages: unknown[], prefix?: string) {
  for (const param of messages) {
    if (param !== undefined) {
      if (prefix) {
        outputChannel.append(prefix);
      }
      if (typeof param === 'string') {
        outputChannel.appendLine(param);
      } else if (Buffer.isBuffer(param)) {
        outputChannel.appendLine(param.toString('utf-8'));
      } else if (utils.isError(param)) {
        outputChannel.appendLine(`${param.name} - ${param.message}`);
        if (param.stack) {
          outputChannel.appendLine(param.stack);
        }
      } else {
        outputChannel.appendLine(`${JSON.stringify(param, null, 2)}`);
      }
    }
  }
}

export function initUserInteractionProvider(): Disposable {
  io.log.options.logMethod = logToOuputChannelFactory('Log');
  io.userInteractionProvider.showInformationMessage
    = async (message: string, ...buttons: Array<string>) => await window.showInformationMessage(message, ...buttons);
  io.userInteractionProvider.showErrorMessage
    = async (message: string, ...buttons: Array<string>) => await window.showErrorMessage(message, ...buttons);
  io.userInteractionProvider.showWarnMessage
    = async (message: string, ...buttons: Array<string>) => await window.showWarningMessage(message, ...buttons);
  io.userInteractionProvider.showNote = async (note: string) => {
    const buttonTitle = 'Execute';
    const result = await window.showWarningMessage(note, { modal: true }, buttonTitle);
    return result === buttonTitle;
  };
  io.userInteractionProvider.showInputPrompt = async (message: string, defaultValue?: string) => await window.showInputBox({
    placeHolder: message,
    value: defaultValue,
    prompt: message,
    ignoreFocusOut: true
  });
  io.userInteractionProvider.showListPrompt = async (message: string, values: string[]) => await window.showQuickPick(values, {
    placeHolder: message,
    ignoreFocusOut: true
  });

  io.userInteractionProvider.setClipboard = async message => await env.clipboard.writeText(message);
  io.userInteractionProvider.getClipboard = async () => await env.clipboard.readText();

  return {
    dispose: function dispose() {
      for (const [key, value] of Object.entries(outputChannels)) {
        value.dispose();
        delete outputChannels[key];
      }
    }
  };
}
