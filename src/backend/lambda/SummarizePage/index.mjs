import * as crypto from 'crypto';
import zlib from 'zlib';
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
  httpOptions: { timeout: 840000 }, // 14 minutes
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
  if (!lastModified) {
    console.warn(
      'lastModified is either undefined or null. Not caching the summary.'
    );
    return;
  }
  if (!summary) {
    console.warn('Summary is null. Not caching the summary.');
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
        2. Highlight important terms, concepts, or actions using bold.
        3. Use italic to emphasize nuances, supporting details, or sub-points.
        4. Include emojis sparingly in the summary where appropriate.
        5. Ensure the summary is well formatted and free of markdown violations.
        6. Skip any preamble or explanation. Provide only the Markdown summary itself.
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
        3. Highlight important terms, concepts, or actions using bold.
        4. Use italic to emphasize nuances, supporting details, or sub-points.
        5. Include emojis sparingly in the summary where appropriate.
        6. Ensure the summary is well formatted and free of markdown violations.
        7. Skip any preamble or explanation. Provide only the Markdown summary itself.
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

  const maxRetries = parseInt(process.env.MAX_RETRIES) || 3;
  let attempt = 0;
  let response;

  while (attempt < maxRetries) {
    try {
      response = await googleAi.models.generateContent({
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
    } catch (error) {
      attempt++;
      console.error(`generateContent attempt ${attempt} failed:`, error);

      if (attempt >= maxRetries) {
        if (isVideo) {
          throw new Error(
            `Failed to summarize video even after ${maxRetries} attempts. Check if the video is too long (over 1 hour).`
          );
        } else {
          throw new Error(
            `Failed to summarize web page even after ${maxRetries} attempts. Check if the page is too long (over 20MB).`
          );
        }
      }

      // Extract status code from error message
      const statusCodeMatch =
        error.message && error.message.match(/got status:\s*(\d+)/);
      const statusCode = statusCodeMatch
        ? parseInt(statusCodeMatch[1], 10)
        : null;
      if (![429, 499, 500, 503, 504].includes(statusCode)) {
        throw error;
      }

      console.log(`Retrying... (${attempt}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
    }
  }
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

async function decompress(base64String) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof base64String !== 'string') {
        return reject(new Error('Input must be a base64-encoded string'));
      }

      // Convert base64 string to Buffer
      const compressedBuffer = Buffer.from(base64String, 'base64');

      zlib.gunzip(compressedBuffer, (err, decompressedData) => {
        if (err) {
          return reject(new Error(`Decompression failed: ${err.message}`));
        }

        resolve(decompressedData.toString('base64')); // Return base64 string
      });
    } catch (error) {
      reject(error);
    }
  });
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
    const content = body.content ? await decompress(body.content) : null;
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

    if (!summary) {
      throw new Error(
        'There was an issue with generating the summary. Try again later.'
      );
    } else {
      return {
        statusCode: 200,
        body: summary,
      };
    }
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
