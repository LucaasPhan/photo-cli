import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import exifr from 'exifr'
import promptSync from 'prompt-sync'
import { adminDb } from './firebase-admin'
import { v2 as cloudinary } from 'cloudinary'
import crypto from "crypto"
import { Stringifier } from 'postcss'
const prompt = promptSync({ sigint: true })

// Type
type PendingPhoto {
  filePath: string
  hash: string
}

// Error handling
class UploadError extends Error {
    constructor(
      message: string,
      public file?: string
    ) {
      super(message)
      this.name = 'UploadError'
    }
  }
  
// ---------- Firebase ----------
const db = adminDb
const COLLECTION = 'photos'
const CONCURRENCY = 8

// ---------- Cloudinary ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,
  api_key: process.env.CLOUDINARY_API_KEY!,
  api_secret: process.env.CLOUDINARY_API_SECRET!,
})
const CLOUDINARY_FOLDER = 'photo-portfolio'

// ---------- Utils ----------
function isImage(file: string) {
  return /\.(jpg|jpeg|png|webp)$/i.test(file)
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    const stream = fs.createReadStream(filePath)

    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function pad(num: number) {
  return num.toString().padStart(4, '0')
}

async function hashExists(hash: string): Promise<boolean> {
  const snap = await db
    .collection('photos')
    .where('hash', '==', hash)
    .limit(1)
    .get()

  return !snap.empty
}

// ---------- Get next IMG number ----------
async function getNextImageNumber(): Promise<number> {
    const snapshot = await db
      .collection(COLLECTION)
      .orderBy('title', 'desc')
      .limit(1)
      .get()
  
    // DB empty → start from IMG-0000
    if (snapshot.empty) return 0
  
    const lastTitle = snapshot.docs[0].data().title as string
    const match = lastTitle.match(/IMG-(\d+)/)
  
    return match ? parseInt(match[1], 10) + 1 : 0
  }  

// ---------- Upload Photos ----------
async function uploadPhotos() {
  const listFile = prompt('Enter path to text file with photo folders: ').trim()

  if (!fs.existsSync(listFile)) {
    throw new Error('❌ Folder list file not found')
  }

  const folders = fs
    .readFileSync(listFile, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  if (folders.length === 0) {
    console.log('No folders listed')
    return
  }

  let allFiles: string[] = []

  for (const folder of folders) {
    if (!fs.existsSync(folder)) {
      console.warn(`⚠ Skipped missing folder: ${folder}`)
      continue
    }

    const files = fs
      .readdirSync(folder)
      .filter(isImage)
      .map(f => path.join(folder, f))

    allFiles.push(...files)
  }

  allFiles.sort()

  if (allFiles.length === 0) {
    console.log('No images found')
    return
  }

  let counter = await getNextImageNumber()
  let completed = 0
  let failed: string[] = []

  const pending: PendingPhoto[] = []

  for (const filePath of allFiles) {
    const hash = await hashFile(filePath)

    if (await hashExists(hash)) {
      process.stdout.write(` Skipped duplicate: ${path.basename(filePath)}\n`)
      continue
    }

    pending.push({ filePath, hash })
  }

  if (pending.length === 0) {
    console.log('No new photos to upload')
    return
  }

  const uploadQueue = pending.map((item, index) => ({
    ...item,
    id: `IMG-${String(counter + index).padStart(4, '0')}`
  }))

  console.log(`📸 Found ${allFiles.length} photos`)
  console.log(`➡ Starting from IMG-${String(counter).padStart(4, '0')}\n`)

  for (let i = 0; i < uploadQueue.length; i += CONCURRENCY) {
    const batch = uploadQueue.slice(i, i + CONCURRENCY)

    await Promise.all(
      batch.map(async item => {
        const { filePath, id } = item

        try {
          await processPhoto(filePath, id, item.hash)
          completed++
        } catch (err: any) {
          failed.push(id)
          process.stderr.write(`\n❌ ${id}: ${err.message}\n`)
        }

        renderProgress(
          completed + failed.length,
          allFiles.length
        )
      })
    )
  }

  if (failed.length > 0) {
    throw new Error(
      `Upload completed with ${failed.length} failures:\n` +
      failed.join(', ')
    )
  }

  console.log('\n✅ Upload complete')
}
  
// ---------- Process Photo ----------
async function processPhoto(
  filePath: string,
  id: string, 
  fileHash: string
) {
  // 🔍 Skip duplicate content (hash-based)
  if (await hashExists(fileHash)) {
    process.stdout.write(` Skipped duplicate: ${path.basename(filePath)}`)
    return
  }

  const exif = await exifr.parse(filePath, {
    pick: [
      'Model',
      'FNumber',
      'ExposureTime',
      'ISO',
      'DateTimeOriginal',
    ],
  })

  const upload = await cloudinary.uploader.upload(filePath, {
    folder: CLOUDINARY_FOLDER,
    public_id: id,
    unique_filename: false,
    overwrite: false,
  
    transformation: [
      // If width is the long side and > 2048
      {
        if: 'w_gt_2048',
        width: 2048,
        height: 2048,
        crop: 'limit',
      },
      // If height is the long side and > 2048
      {
        if: 'h_gt_2048',
        width: 2048,
        height: 2048,
        crop: 'limit',
      },
    ],
  })

  await adminDb.collection(COLLECTION).doc(id).set({
    title: id,
    imageUrl: upload.secure_url,
    width: upload.width,
    height: upload.height,

    camera: exif?.Model ?? null,
    aperture: exif?.FNumber ? `f/${exif.FNumber}` : null,
    shutterSpeed: exif?.ExposureTime
      ? `1/${Math.round(1 / exif.ExposureTime)}`
      : null,
    iso: exif?.ISO ?? null,
    shotDate: exif?.DateTimeOriginal
      ? new Date(exif.DateTimeOriginal)
      : null,

    hash: fileHash,
    featured: false,
  })
}
  
// ---------- Set Featured ----------
async function setFeatured() {
  const input = prompt(
    'Enter image numbers to feature (example: 5001,5003,5010): '
  )

  const numbers = input
    .split(',')
    .map(n => n.trim())
    .filter(Boolean)

  for (const num of numbers) {
    const id = `IMG-${pad(Number(num))}`
    const ref = db.collection(COLLECTION).doc(id)

    if (!(await ref.get()).exists) {
      console.log(`❌ ${id} not found`)
      continue
    }

    await ref.update({ featured: true })
    console.log(`⭐ Marked ${id} as featured`)
  }
}

// ---------- Remove Featured ----------
async function clearFeatured() {
  const snapshot = await db
    .collection(COLLECTION)
    .where('featured', '==', true)
    .get()

  for (const doc of snapshot.docs) {
    await doc.ref.update({ featured: false })
  }

  console.log('🧹 All featured flags removed')
}

// ---------- Reset Database ----------
async function resetDatabase() {
  console.log('\n⚠️  DANGER: This will DELETE ALL PHOTOS')

  const first = prompt('Type RESET to confirm: ')
  if (first !== 'RESET') return

  const snapshot = await db.collection(COLLECTION).get()
  const batch = db.batch()

  snapshot.docs.forEach(doc => batch.delete(doc.ref))
  await batch.commit()
  
  console.log('Firebase cleared')
  // Cloudinary
  await resetCloudinary()

  console.log('Cloudinary cleared')
}

function renderProgress(done: number, total: number) {
  const width = 30
  const percent = Math.floor((done / total) * 100)
  const filled = Math.floor((done / total) * width)

  const bar =
    '█'.repeat(filled) +
    '░'.repeat(width - filled)

  process.stdout.write(
    `\r[${bar}] ${percent}% (${done}/${total})`
  )

  if (done === total) {
    process.stdout.write('\n')
  }
}

// Reset Cloudinary
async function resetCloudinary() {
  let nextCursor: string | undefined = undefined

  do {
    const result = await cloudinary.api.resources({
      type: 'upload',
      prefix: CLOUDINARY_FOLDER,
      max_results: 100,
      next_cursor: nextCursor,
    })

    if (result.resources.length === 0) break

    const publicIds = result.resources.map(
      (r: any) => r.public_id
    )

    await cloudinary.api.delete_resources(publicIds)

    nextCursor = result.next_cursor
  } while (nextCursor)

  console.log('🗑️ Cloudinary folder wiped')
}

  
// ---------- Main Menu ----------
async function main() {
  while (true) {
    console.log(`
What do you want to do?
1) Upload photos
2) Set featured photos
3) Remove all featured photos
4) Reset database (PROCEED WITH CAUTION)
5) Exit
`)

    const choice = prompt('Select an option: ')

    if (choice === '1') await uploadPhotos()
        .then(() => {
          console.log('🎉 All photos uploaded successfully')
          process.exit(0)
        })
        .catch(err => {
          console.error('\n🚨 Upload failed')
          console.error(err.message)
          process.exit(1)
        })
    else if (choice === '2') await setFeatured()
    else if (choice === '3') await clearFeatured()
    else if (choice === '4') await resetDatabase()
    else if (choice === '5') process.exit(0)
  }
}

main().catch(console.error)
