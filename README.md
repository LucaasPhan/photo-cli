# Photo CLI
A Node.js CLI tool to manage a photography portfolio. It uploads photos from local folders, extracts EXIF metadata, uploads images to Cloudinary, stores metadata in Firebase Firestore, and manages featured photos.
This CLI is designed to be safe, repeatable, and idempotent. Duplicate photos are automatically skipped using file hashing.

## Features
* 📤 Batch upload photos from multiple folders
* 🔁 Skip duplicate images using SHA-1 hash
* 🏷 Auto-rename images to sequential IMG-XXXX
* 📷 Extract EXIF metadata (camera, ISO, aperture, shutter, shot date)
* ☁ Upload images to Cloudinary
* 🔥 Store metadata in Firebase Firestore
* ⭐ Mark photos as featured
* 🧹 Clear all featured photos
* 💥 Reset database with double confirmation
* 📊 CLI progress bar
* ⚠ Strong error handling with hard failures

## Tech Stack
* Node.js + TypeScript
* Firebase Firestore (Admin SDK)
* Cloudinary
* exifr for EXIF parsing
* prompt-sync for CLI interaction

## Project Structure
```
project-root/
├── photos-cli.ts                # Main CLI entry point
├── firebase-admin.ts
├── .env
├── package.json
└── README.md
```
## Setup 
Run:
```
npm install
```

Create a firebase-admin.ts file: 
```
import admin from "firebase-admin"
import serviceAccount from "../../credentials/firebase-admin.json"

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
  })
}

export const adminDb = admin.firestore()
```
Then create a file from root/credentials/firebase-admin.json<br>
Copy the private key from Firebase in


## Environment Variables
Create a .env file:
```
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```
Firebase Admin credentials should be configured inside firebase-admin.ts.

## Input Format (Upload)
The upload command expects a text file that lists photo folders.
Example folders.txt
```
/Users/me/photos/2023/trip
/Users/me/photos/2024/portraits
```
* Each line is a folder path
* All images inside each folder are scanned
* Supported formats: jpg, jpeg, png, webp

## How Uploading Works
1. All folders are scanned recursively (non-recursive per folder)
2. Images are sorted alphabetically
3. The next available IMG-XXXX number is detected from Firestore
4. Each file:
    * Is hashed (SHA-1)
    * Skipped if hash already exists in database
    * Uploaded to Cloudinary
    * Stored in Firestore with metadata
If the database is empty, numbering starts at:
```
IMG-0000
```
## Firestore Document Schema
Collection: photos
```
{
  title: string           // IMG-XXXX
  imageUrl: string
  width: number
  height: number

  camera: string | null
  aperture: string | null
  shutterSpeed: string | null
  iso: number | null
  shotDate: Date | null

  hash: string            // SHA-1
  featured: boolean
}
```
## CLI Usage
Run the CLI:

`npx ts-node src/photos-cli.ts`

You will see:
```
What do you want to do?

[1] Upload photos
[2] Set featured photos
[3] Remove all featured photos
[4] Reset database (DANGEROUS)
[0] Exit
```
## Upload Photos
Choose option [1] Upload photos
You will be prompted for the path to the text file:

`Enter path to text file with photo folders:`

The CLI will:
* Upload in batches
* Show a progress bar
* Fail hard if any photo errors occur

## Set Featured Photos
Choose option [2] Set featured photos
Input image numbers only:

Enter image numbers to feature (example: 5001,5003,5010):
This will mark:
```
IMG-5001
IMG-5003
IMG-5010
```
as featured: true.

## Remove All Featured Photos
Choose option [3] Remove all featured photos
This resets all featured flags to false.

## Reset Database (Dangerous)
Choose option [4] Reset database
Requires double confirmation:
```
Type RESET to continue:
Type DELETE ALL to confirm:
```
This permanently deletes all photo documents from Firestore.

## Error Handling
* Duplicate photos are skipped safely
* Upload failures stop the process
* Errors throw and exit with non-zero status
* Progress bar updates on a single line

## Recommended Usage
* Always upload from raw folders
* Never manually edit IMG-XXXX
* Use featured flags for homepage selection
* Backup Firestore before resetting

## Notes
* The CLI is intentionally dependency-light
* prompt-sync is used instead of inquirer for reliability
* Designed for local + CI environments