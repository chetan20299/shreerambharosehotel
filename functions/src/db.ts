import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

/**
 * Three ways this runs:
 *  - Firebase Cloud Functions: FIREBASE_CONFIG is provided automatically.
 *  - Netlify (or any other server): service-account credentials from env vars
 *      FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY (\n escaped), optional FIREBASE_STORAGE_BUCKET.
 *  - Local tests / emulators: the demo project.
 */
if (!getApps().length) {
  const env = process.env;
  if (env.FIREBASE_CONFIG) initializeApp();
  else if (env.FIREBASE_PRIVATE_KEY && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PROJECT_ID) {
    initializeApp({
      credential: cert({ projectId: env.FIREBASE_PROJECT_ID, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }),
      projectId: env.FIREBASE_PROJECT_ID,
      storageBucket: env.FIREBASE_STORAGE_BUCKET || undefined,
    });
  } else {
    const projectId = env.GCLOUD_PROJECT ?? 'demo-srbh';
    initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` });
  }
}

export const db = getFirestore();
export const bucket = () => getStorage().bucket();
export { FieldValue, Timestamp };
