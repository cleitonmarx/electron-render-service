/* eslint-disable no-console */
const pjson = require('../package.json');
const { BrowserWindow } = require('electron');
const ipc = require('electron').ipcMain;
const retry = require('retry');

const { validateResult } = require('./error_handler');

const TIMEOUT = parseInt(process.env.TIMEOUT, 10) || 30;
const DEVELOPMENT = process.env.NODE_ENV === 'development';
const WINDOW_WIDTH = parseInt(process.env.WINDOW_WIDTH, 10) || 1024;
const WINDOW_HEIGHT = parseInt(process.env.WINDOW_HEIGHT, 10) || 768;
const DEFAULT_HEADERS = 'Cache-Control: no-cache, no-store, must-revalidate\nPragma: no-cache';

/**
 * Render PDF
 */
function renderPDF(options, done) {
  // Remove print stylesheets prior rendering
  if (options.removePrintMedia) {
    const selector = 'document.querySelectorAll(\'link[rel="stylesheet"][media="print"]\')';
    const code = `Array.prototype.forEach.call(${selector}, s => s.remove());`;
    this.webContents.executeJavaScript(code);

  }

  // Support setting page size in microns with NxN syntax
  const customPage = options.pageSize.match(/([0-9]+)x([0-9]+)/);
  if (customPage) {
    options.pageSize = { // eslint-disable-line no-param-reassign
      width: parseInt(customPage[1], 10),
      height: parseInt(customPage[2], 10),
    };
  }

  this.webContents.printToPDF(options, done);
}

/**
 * Render image png/jpeg
 */
function renderImage({ type, quality, clippingRect, browserWidth, browserHeight, target, targetSize }, done) {
  const handleCapture = image => done(null, type === 'png' ? image.toPng() : image.toJpeg(quality));
  var timeout = 0;
  if (target) {
    currentSize = this.getSize()
    if (targetSize.width == currentSize[0] && targetSize.height == currentSize[1]) {
      setTimeout(() => this.capturePage(handleCapture), 100);
    } else {
      this.setSize(targetSize.width, targetSize.height);
      setTimeout(() => this.capturePage(handleCapture), 1000);
    }

  } else if (clippingRect) {
    // Avoid stretching by adding rect coordinates to size
    this.setSize(browserWidth + clippingRect.x, browserHeight + clippingRect.y);
    setTimeout(() => this.capturePage(clippingRect, handleCapture), 50);
  } else {
    this.setSize(browserWidth, browserHeight);
    setTimeout(() => this.capturePage(handleCapture), 50);
  }
}


/**
 * Render job with error handling
 */
exports.renderWorker = function renderWorker(window, task, done) {
  const { webContents } = window;
  let waitOperation = null;

  const timeoutTimer = setTimeout(() => webContents.emit('timeout'), TIMEOUT * 1000);

  if (task.waitForText !== false) {
    waitOperation = retry.operation({
      retries: TIMEOUT,
      factor: 1,
      minTimeout: 750,
      maxTimeout: 1000,
    });
  }

  webContents.once('finished', (type, ...args) => {
    clearTimeout(timeoutTimer);

    function renderIt() {
      validateResult(task.url, type, ...args)
        // Page loaded successfully
        .then(() => (task.type === 'pdf' ? renderPDF : renderImage).call(window, task, done))
        .catch(ex => done(ex));
    }

    // Delay rendering n seconds
    if (task.delay > 0) {
      console.log('delaying pdf generation by %sms', task.delay);
      setTimeout(renderIt, task.delay);

      // Look for specific string before rendering
    } else if (task.waitForText) {
      console.log('delaying pdf generation, waiting for text "%s" to appear', task.waitForText);
      waitOperation.attempt(() => webContents.findInPage(task.waitForText));

      webContents.on('found-in-page', function foundInPage(event, result) {
        if (result.matches === 0) {
          waitOperation.retry(new Error('not ready to render'));
          return;
        }

        if (result.finalUpdate) {
          webContents.stopFindInPage('clearSelection');
          webContents.removeListener('found-in-page', foundInPage);
          renderIt();
        }
      });
    } else if (task.target) {
      ipc.on('target_size_received', function targetSizeReceived(event, targetSize) {
        if (targetSize) {
          task.targetSize = targetSize;
        }
        ipc.removeListener('target_size_received', targetSizeReceived);
        renderIt();
      });

      webContents.executeJavaScript(`
        var domReady = function(callback) {
          document.readyState === "complete" ? callback() : window.addEventListener("load", callback);
        };

        var ipc = require('electron').ipcRenderer
        domReady(function(){
          var target = document.getElementById('`+ task.target + `')
          if (target != null) {
            var targetSize = {
              width: target.offsetWidth,
              height: target.offsetHeight
            };
            ipc.send('target_size_received',targetSize);
          } else {
            ipc.send('target_size_received', {width:0, height:0});
          }
        });
    `);

    } else {
      ipc.on('domready', function domReady(event) {
        ipc.removeListener('domready', domReady);
        renderIt();
      });

      webContents.executeJavaScript(`
        var domReady = function(callback) {
          document.readyState === "complete" ? callback() : document.addEventListener("load", callback);
        };
        var ipc = require('electron').ipcRenderer
        domReady(function(){
          ipc.send('domready');
        });
    `);
    }
  });

  webContents.loadURL(task.url, { extraHeaders: DEFAULT_HEADERS });
};

/**
 * Create BrowserWindow
 */
exports.createWindow = function createWindow() {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    frame: DEVELOPMENT,
    show: DEVELOPMENT,
    transparent: true,
    enableLargerThanScreen: true,
    webPreferences: {
      blinkFeatures: 'OverlayScrollbars', // Slimmer scrollbars
      allowDisplayingInsecureContent: true, // Show http content on https site
      allowRunningInsecureContent: true, // Run JS, CSS from http urls
    },
  });

  // Set user agent
  const { webContents } = window;
  webContents.setUserAgent(`${webContents.getUserAgent()} ${pjson.name}/${pjson.version}`);

  // Emit end events to an aggregate for worker to listen on once
  ['did-fail-load', 'crashed', 'did-finish-load', 'timeout'].forEach(e => {
    webContents.on(e, (...args) => webContents.emit('finished', e, ...args));
  });

  return window;
};
