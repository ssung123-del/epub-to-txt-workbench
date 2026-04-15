# EPUB TXT Workbench

A local browser tool for converting EPUB files into clean TXT files.

## What It Does

- Converts one or many `.epub` files to `.txt`
- Keeps all processing in the browser
- Extracts EPUB metadata such as title, creator, and language
- Supports chapter dividers, metadata headers, and whitespace cleanup
- Previews converted text with search and copy controls
- Downloads one TXT file or a ZIP bundle for batch conversions

## Privacy

Files are not uploaded to a server. The app reads EPUB files in your browser with JSZip and creates downloadable TXT results locally.

## Usage

Open `index.html` in a browser, then choose or drag EPUB files into the upload area.

## Validation

The current JavaScript passes:

```bash
node --check script.js
```
