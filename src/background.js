'use strict';

import { crx, expect } from 'playwright-crx/test';
import { bytesToBase64 } from 'byte-base64';

// Allows users to open the side panel by clicking on the action toolbar icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

async function forceLoadLazyImages(page) {
  return page.evaluate(() => {
    for (const image of document.querySelectorAll('img[loading="lazy"]')) {
      image.setAttribute('loading', 'eager');
    }
  });
}

async function exportAsPdf(page) {
  await page.emulateMedia({ media: 'print' });
  return await page.pdf({
    printBackground: true,
    margin: {
      bottom: '0.5in',
      left: '0.5in',
      right: '0.5in',
      top: '0.5in',
    },
  });
}

async function getLastModifiedTimestamp(page) {
  // Get the last modified timestamp from page source
  let lastModified = await page.evaluate(() => {
    const meta = document.head.querySelector(
      'meta[property="og:updated_time"]'
    );
    return meta ? meta.getAttribute('content') : null;
  });
  // If not found, fallback to the last modified date in the HTTP headers
  if (!lastModified) {
    lastModified = await page.evaluate(async () => {
      const resp = await fetch(window.location.href, { method: 'HEAD' });
      return resp.headers.get('Last-Modified');
    });
  }
  console.log('Page was last modified on:', lastModified);
  return lastModified;
}

// Extension lifecycle events
chrome.runtime.onInstalled.addListener((details) => {
  const { reason, previousVersion } = details;

  console.log(`Extension event: ${reason}`);

  if (reason === 'install') {
    console.log('Extension installed');
  } else if (reason === 'update') {
    console.log(`Extension updated from ${previousVersion}`);
  }
});

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.task == 'summarize') {
    console.log('Background message received:', JSON.stringify(message));
    const tabId = message.tabId;
    const url = message.webUrl;
    var crxApp, page;

    (async () => {
      crxApp = await crx.start();
      try {
        // Tries to connect to the active tab, or creates a new one
        page = await crxApp.attach(tabId).catch(() => crxApp.newPage());
        // Ensures the page is navigated to the correct URL
        await expect(page).toHaveURL(url);
        // Wait for page to fully load
        await page.waitForLoadState('networkidle');
        // Handles lazy loading
        await forceLoadLazyImages(page);
        // Export page as PDF
        const pdf = await exportAsPdf(page);
        const pdfBase64 = bytesToBase64(pdf);
        const lastModified = await getLastModifiedTimestamp(page);
        const lambdaResponse = await fetch(
          'https://t2zkpumsqx3zrd5ypxljjjpokq0bppdb.lambda-url.ap-south-1.on.aws/',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
            },
            body: JSON.stringify({
              webUrl: url,
              content: pdfBase64,
              lastModified: lastModified,
            }),
          }
        );
        const statusCode = lambdaResponse.status;
        if (statusCode === 200) {
          const summary = await lambdaResponse.text();
          sendResponse({
            success: true,
            summary: summary,
          });
        } else {
          const error = await lambdaResponse.json();
          console.log('Error from Lambda:', JSON.stringify(error));
          sendResponse({
            success: false,
            error: error.message,
          });
        }
      } catch (error) {
        console.log(error);
        sendResponse({
          success: false,
          error: error.message,
        });
      } finally {
        if (typeof crxApp !== 'undefined' && typeof page !== 'undefined') {
          // page stays open, but no longer controlled by playwright
          await crxApp.detach(page);
          // releases chrome.debugger
          await crxApp.close();
        }
      }
    })();
    return true;
  }
});
