'use strict';

import { crx, expect } from 'playwright-crx/test';
import zlib from 'zlib';

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
  let lastModified = await page.evaluate(() => {
    // Check both meta tags in one page evaluation
    const metaTags = [
      'meta[property="og:updated_time"]',
      'meta[property="article:published_time"]',
    ];

    for (const selector of metaTags) {
      const meta = document.head.querySelector(selector);
      if (meta) {
        const date = meta.getAttribute('content');
        if (date) {
          return date;
        }
      }
    }

    return null;
  });

  // Try to fetch the last-modified header via fetch inside the page context
  if (!lastModified) {
    lastModified = await page.evaluate(async () => {
      try {
        const resp = await fetch(window.location.href, { method: 'HEAD' });
        const header = resp.headers.get('last-modified');
        return header ? header : null;
      } catch (error) {
        console.error('Error fetching last-modified header:', error);
        return null;
      }
    });
  }

  // Fallback to current date if no valid date found
  if (!lastModified || isNaN(new Date(lastModified).getTime())) {
    console.warn(
      'No valid last modified date found. Using current date as fallback.'
    );
    // Use current UTC date as fallback
    lastModified = new Date().toISOString().split('T')[0];
  }

  console.log('Page was last modified on:', lastModified);
  return lastModified;
}

async function compressAndConvertToBase64(data) {
  return new Promise((resolve, reject) => {
    // Compress data using gzip
    zlib.gzip(data, (err, compressedData) => {
      if (err) return reject(err);

      // Convert the compressed Buffer to Base64
      const base64Data = compressedData.toString('base64');
      resolve(base64Data); // Return Base64 encoded string
    });
  });
}

async function handleWebPage(tabId, url, sendResponse) {
  let crxApp, page;

  try {
    crxApp = await crx.start();
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
    // Compress the PDF using zlib and convert to base64
    const compressedPdfBase64 = await compressAndConvertToBase64(pdf);
    const lastModified = await getLastModifiedTimestamp(page);
    const lambdaResponse = await fetch(
      '<Paste your Lambda function URL here>',
      // 'https://abcxyz.lambda-url.ap-south-1.on.aws/',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: JSON.stringify({
          webUrl: url,
          content: compressedPdfBase64,
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
}

async function handleYouTubeVideo(url, sendResponse) {
  try {
    const lambdaResponse = await fetch(
      '<Paste your Lambda function URL here>',
      // 'https://abcxyz.lambda-url.ap-south-1.on.aws/',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          videoUrl: url,
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
  }
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

    (async () => {
      if (url.includes('youtube.com/watch') || url.includes('youtu.be/')) {
        await handleYouTubeVideo(url, sendResponse);
      } else {
        await handleWebPage(tabId, url, sendResponse);
      }
    })();
    return true;
  }
});
