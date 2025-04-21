'use strict';

import './sidepanel.css';
import { marked } from 'marked';

(async function () {
  document.addEventListener('DOMContentLoaded', async () => {
    const [contentBox] = document.getElementsByClassName('summarize-content');

    try {
      // Get the active tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTabId = tabs[0]?.id;
      const activeTabUrl = tabs[0]?.url;

      if (!activeTabId) {
        throw new Error('No active tab found.');
      }

      // Send message to the service worker for processing
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            task: 'summarize',
            tabId: activeTabId,
            webUrl: activeTabUrl,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          }
        );
      });

      if (response.error) {
        throw new Error(response.error);
      }

      // Convert Markdown to HTML safely
      const markdownHTML = marked.parse(response.summary);

      // Inject Markdown-rendered HTML
      contentBox.innerHTML = `<div class="markdown-content">${markdownHTML}</div>`;
    } catch (error) {
      console.error('Error:', error.message);
      contentBox.innerHTML = `<pre class="error-text">${error.message}</pre>`;
    }
  });
})();
