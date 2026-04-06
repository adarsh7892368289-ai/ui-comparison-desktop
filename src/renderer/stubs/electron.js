const noop        = () => {};
const noopAsync   = () => Promise.resolve(null);
const noopEmitter = { addListener: noop, removeListener: noop, emit: noop };

module.exports = {
  app: {
    quit:              noop,
    exit:              noop,
    getVersion:        () => '0.0.0',
    getPath:           () => '',
    on:                noop,
    once:              noop,
    removeListener:    noop,
    isReady:           () => false,
    whenReady:         noopAsync,
    commandLine:       { appendSwitch: noop, appendArgument: noop },
  },
  ipcRenderer: {
    send:              noop,
    sendSync:          () => null,
    invoke:            noopAsync,
    on:                () => noopEmitter,
    once:              noop,
    removeListener:    noop,
    removeAllListeners: noop,
  },
  ipcMain: {
    on:                noop,
    once:              noop,
    handle:            noop,
    handleOnce:        noop,
    removeHandler:     noop,
    removeListener:    noop,
    removeAllListeners: noop,
  },
  contextBridge: {
    exposeInMainWorld: noop,
  },
  shell: {
    openExternal:      noopAsync,
    openPath:          noopAsync,
    showItemInFolder:  noop,
    beep:              noop,
  },
};