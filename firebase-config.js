/**
 * Signal — live feedback backend configuration
 * ---------------------------------------------
 * The feedback wall at the bottom of the site needs somewhere shared to
 * store entries so every visitor sees the same list, not just their own
 * browser. This project uses Firebase Firestore's free tier for that —
 * there is no server of your own to write or run.
 *
 * ONE-TIME SETUP (about 5 minutes, no credit card required):
 *
 *   1. Go to https://console.firebase.google.com and create a free
 *      project (any name is fine).
 *
 *   2. Inside the project, click the "</>" (web app) icon to register a
 *      web app. Firebase will show you a config object that looks like
 *      the placeholder below — copy your real values into it here.
 *
 *   3. In the left sidebar, open "Firestore Database" → "Create
 *      database". Choose any region close to your users; starting in
 *      production mode is fine.
 *
 *   4. Open the "Rules" tab of Firestore and paste in the contents of
 *      firestore.rules (shipped alongside this file), then click
 *      "Publish". This is what allows visitors to post feedback and
 *      replies without needing an account, while stopping them from
 *      editing or deleting each other's entries.
 *
 *   5. Reload the site. The small note under the feedback form will
 *      switch from "Saved on this device only" to "Visible to everyone"
 *      once this is filled in correctly.
 *
 * Until steps 1-4 are done, the feedback form still works, but only
 * saves to the current browser (localStorage) — it will not be visible
 * to other visitors, and replies won't sync either.
 *
 * Nothing here is secret: a Firebase web config is safe to ship in
 * public client-side code — access is controlled by the Firestore rules
 * in step 4, not by hiding this file.
 */
window.SIGNAL_FIREBASE_CONFIG = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};
