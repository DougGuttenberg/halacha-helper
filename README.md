# HalachaHelper

A rabbi's helper tool for Jewish law questions. Powered by AI with sources from Sefaria.

## Setup

1. Clone this repo
2. Install Vercel CLI: `npm i -g vercel`
3. Set up environment variable:
   ```
   vercel env add ANTHROPIC_API_KEY
   ```
4. Deploy: `vercel --prod`

## Local Development

1. Create `.env.local` with your API key:
   ```
   ANTHROPIC_API_KEY=your-key-here
   ```
2. Run: `vercel dev`

## Structure

- `/public/index.html` - The frontend
- `/api/ask.js` - Serverless function that calls Anthropic API
