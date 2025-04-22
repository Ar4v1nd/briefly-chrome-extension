import * as crypto from 'crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const googleAi = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: 300000 }, // 5 minutes
});
const model = process.env.GOOGLE_GENAI_MODEL_ID || 'gemini-2.0-flash';
const ddbClient = new DynamoDBClient();
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
const youtubeApiKey = process.env.YOUTUBE_DATA_API_KEY;

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

async function callYouTubeVideoListApi(videoId) {
  const url = `https://youtube.googleapis.com/youtube/v3/videos?part=snippet%2CcontentDetails&id=${videoId}&key=${youtubeApiKey}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
  const data = await response.json();
  if (data.items && data.items.length > 0) {
    return {
      snippet: data.items[0].snippet,
      contentDetails: data.items[0].contentDetails,
    };
  } else {
    throw new Error(`No YouTube video found with ID: ${videoId}`);
  }
}

async function callGoogleAi(content, isVideo = false) {
  let contents;
  if (isVideo) {
    contents = [
      {
        fileData: {
          fileUri: content,
        },
      },
      {
        text: `
        Summarize this video as key-points in valid Markdown format by following the instructions given below:
        1. Identify the main theme/topic of the video and use it as the main heading of the summary.
        2. Include emojis sparingly in the summary where appropriate.
        3. Ensure the summary is well formatted and free of markdown violations.
        4. Skip any preamble or explanation. Provide only the Markdown summary itself.
        `,
      },
    ];
  } else {
    contents = [
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
          data: content,
        },
      },
    ];
  }

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

function getVideoIdFromUrl(url) {
  const urlObj = new URL(url);
  if (urlObj.hostname === 'www.youtube.com') {
    return urlObj.searchParams.get('v');
  }
  if (urlObj.hostname === 'youtu.be') {
    return urlObj.pathname.substring(1);
  }
  return null;
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
    const url = body.webUrl ? body.webUrl : body.videoUrl;
    const content = body.content ? body.content : null;
    let lastModified = body.lastModified ? body.lastModified : null;

    console.log('Lambda got the following URL for summarization: ', url);

    let videoId = null;
    if (!content && !lastModified) {
      console.log(
        'content and lastModified are both null. This means that the web page is probably a YouTube video.'
      );
      // Extract videoId from the URL
      videoId = getVideoIdFromUrl(url);
      if (!videoId) {
        throw new Error('Invalid YouTube URL');
      }
      console.log('Extracted videoId: ', videoId);
      // Get video metadata using YouTube Data API
      const videoMeta = await callYouTubeVideoListApi(videoId);
      // Set lastModified to the video publish date
      lastModified = videoMeta.snippet.publishedAt;
      console.log('lastModified is set to: ', lastModified);
    }

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

    let summary = null;
    if (!content) {
      // Send URL to Gemini for summarization
      summary = await callGoogleAi(url, true);
    } else {
      // Send PDF to Gemini for summarization
      summary = await callGoogleAi(content);
    }
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
