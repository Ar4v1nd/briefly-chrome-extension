import * as crypto from 'crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const googleAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = process.env.GOOGLE_GENAI_MODEL_ID || 'gemini-2.0-flash';
const ddbClient = new DynamoDBClient();
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

async function getCachedSummary(urlHash) {
  console.log('Checking cache for summary');
  const command = new GetCommand({
    TableName: process.env.DDB_CACHE_TABLE,
    Key: {
      urlHash: urlHash,
    },
  });
  const response = await ddbDocClient.send(command);
  return response.Item;
}

async function cacheSummary(urlHash, url, lastModified, summary) {
  if (typeof lastModified === 'undefined' || lastModified === null) {
    console.warn(
      'lastModified is either undefined or null. Not caching the summary.'
    );
    return;
  }
  console.log('Caching summary');
  const command = new PutCommand({
    TableName: process.env.DDB_CACHE_TABLE,
    Item: {
      urlHash: urlHash,
      url: url,
      lastModified: lastModified,
      summary: summary,
      expireAt: Math.floor((Date.now() + 90 * 24 * 60 * 60 * 1000) / 1000), // 90 days
    },
  });
  await ddbDocClient.send(command);
}

async function updateCacheExpiry(urlHash) {
  console.log('Updating cache expiry');
  const command = new UpdateCommand({
    TableName: process.env.DDB_CACHE_TABLE,
    Key: {
      urlHash: urlHash,
    },
    UpdateExpression: 'set expireAt = :expireAt',
    ExpressionAttributeValues: {
      ':expireAt': Math.floor((Date.now() + 90 * 24 * 60 * 60 * 1000) / 1000), // 90 days
    },
  });
  await ddbDocClient.send(command);
}

async function callGoogleAi(pdfBase64) {
  const contents = [
    {
      text: `
      Summarize this web page as key-points in valid Markdown format by following the instructions given below:
      1. Identify the main theme/topic of the web page and use it as the main heading of the summary.
      2. Ignore extraneous content like author bios, introductory fluff, or purely decorative images unless they convey key technical information. Focus solely on the core message and technical details.
      3. Include emojis sparingly in the summary where appropriate.
      4. Ensure the summary is well formatted and free of markdown violations.
      5. Skip any preamble or explanation. Provide only the Markdown summary itself.
      `,
    },
    {
      inlineData: {
        mimeType: 'application/pdf',
        data: pdfBase64,
      },
    },
  ];

  const response = await googleAi.models.generateContent({
    model: model,
    contents: contents,
    config: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
            description: 'Summary in Markdown format',
            nullable: false,
          },
        },
        required: ['summary'],
      },
    },
  });
  console.log('Token usage:', response.usageMetadata);
  let result = JSON.parse(response.text);
  return result['summary'];
}

export const handler = async (event) => {
  try {
    let body = event.body;
    const isBase64Encoded = event.isBase64Encoded
      ? event.isBase64Encoded
      : false;
    // If the body is base64 encoded, decode it
    if (isBase64Encoded) {
      body = Buffer.from(body, 'base64').toString('utf-8');
    }
    body = JSON.parse(body);
    const url = body.webUrl;
    const content = body.content;
    const lastModified = body.lastModified ? body.lastModified : null;

    console.log('Lambda got the following URL for summarization: ', url);

    const urlHash = crypto.createHash('sha256').update(url).digest('hex');

    // Check if summary is cached in DynamoDB
    const cached_summary = await getCachedSummary(urlHash);

    // If summary is cached and the page hasn't been modified since then, return the cached summary
    if (
      cached_summary &&
      Date.parse(cached_summary.lastModified) >= Date.parse(lastModified)
    ) {
      console.log(
        'Returning cached summary as the page has not changed since then'
      );
      await updateCacheExpiry(urlHash);
      return {
        statusCode: 200,
        body: cached_summary.summary,
      };
    }

    // Send PDF to Gemini for summarization
    const summary = await callGoogleAi(content);

    // Cache the summary in DynamoDB
    await cacheSummary(urlHash, url, lastModified, summary);

    return {
      statusCode: 200,
      body: summary,
    };
  } catch (error) {
    console.log(error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        name: error.name,
        message: error.message,
      }),
    };
  }
};
