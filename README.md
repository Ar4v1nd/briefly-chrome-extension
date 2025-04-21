# ![Briefly](public/icons/icon_48.png) Briefly

A Google Chrome extension that helps summarize web pages and youtube videos using generative AI.

## Prerequisites

* Node/NPM
* AWS Account
* API Key from Google AI Studio

## Setting up

After cloning the repo:

* Create an AWS Lambda function (with at least 256 MB memory) and copy the code from `src/backend/lambda/SummarizePage/index.mjs`.
* Add a custom layer for the `@google/genai` npm package.
* Create a DynamoDB table named `SummaryCacheTable` with `urlHash (string)` as the partition key.
* Sign up for Google AI Studio and get the API key for the `gemini-2.0-flash` model (or any other model of your choice).
* In your Lambda function, create the following environment variables:
  * Key: DDB_CACHE_TABLE, Value: SummaryCacheTable
  * Key: GEMINI_API_KEY, Value: API key copied from Google AI Studio
  * (Optional) Key: GOOGLE_GENAI_MODEL_ID, Value: Google GenAI model ID to use (defaults to `gemini-2.0-flash`)

## Local Testing

* Inside the project folder, run:

    ```bash
    npm run watch
    ```

* Open `chrome://extensions`
* Check the `Developer mode` checkbox
* Click on the `Load unpacked` extension button
* Select the folder `briefly-chrome-extension/build`
* Navigate to any web page or youtube video and click on the `Briefly` extension icon.
* A sidepanel should now open with the summary populated within a few seconds.

## Build for publishing on Chrome Web Store

* Inside the project folder, run:

    ```bash
    npm run build && npm run pack
    ```

## Contribution

Suggestions and pull requests are welcomed!.

---

This project was bootstrapped with [Chrome Extension CLI](https://github.com/dutiyesh/chrome-extension-cli)
