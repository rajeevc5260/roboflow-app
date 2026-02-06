# Roboflow Detect & Crop App

Node.js CLI app that uses the [Roboflow](https://docs.roboflow.com/) API to detect objects in an image and save each detection as a cropped image.

## Setup

1. **Install dependencies**

   ```bash
   cd roboflow-app
   pnpm install
   ```

   Or with npm: `npm install`

2. **Add your API key**

   Copy the example env file and set your Roboflow API key:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set:

   ```env
   ROBOFLOW_API_KEY=your_roboflow_api_key_here
   ```

   Get your API key from [Roboflow Settings](https://app.roboflow.com/settings/api).

## Usage

1. **Put your drawing in the `upload/` folder**  
   Place an image there (e.g. `upload/drawing.png`) or any supported image (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.bmp`). If you use `drawing.png`, that file is used by default; otherwise the first image in `upload/` is used.

2. **Run detection** (no arguments = use image from `upload/`):

   ```bash
   pnpm run detect
   # or
   node index.js
   ```

3. **Or pass a custom image path**:

   ```bash
   node index.js ./path/to/your/image.png
   pnpm run detect -- ./upload/my-drawing.png
   ```

Detected objects are cropped and saved in the `outputs/` folder as `{originalName}_{class}_{index}.png`.

## Model

Uses the Roboflow model: `drawing-gpc4l/7` (configurable in `index.js`).

## Docs

- [Roboflow Documentation](https://docs.roboflow.com/)
- [Serverless Hosted API](https://docs.roboflow.com/deploy/serverless-hosted-api) (detect endpoint)
# roboflow-app
