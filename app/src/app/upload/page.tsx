import { unstable_noStore as noStore } from "next/cache";

import { loadAppFrameData, loadUploadOverview } from "../../../lib/app-overview";
import { AppShell } from "../AppShell";
import { requireCreatorSession } from "../app-session";

import { UploadPicker } from "./UploadPicker";
import styles from "./upload.module.css";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function UploadPage() {
  noStore();

  const session = await requireCreatorSession();
  const [frame, uploadOverview] = await Promise.all([
    loadAppFrameData(session.creatorId),
    loadUploadOverview(session.creatorId),
  ]);

  return (
    <AppShell activeTab="upload" reviewCount={frame.reviewCount}>
      <section className={styles.stack}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Upload</p>
          <h1 className={styles.title}>Feed the machine</h1>
        </header>

        {uploadOverview.needsMindCorpus ? (
          <section className={styles.mindPrompt} aria-labelledby="mind-prompt-title">
            <h2 className={styles.sectionTitle} id="mind-prompt-title">
              Your Mind needs a corpus
            </h2>
            <p>
              Upload a long video so your Mind can learn your voice before it
              ranks clips.
            </p>
          </section>
        ) : null}

        <section className={styles.uploadCard} aria-label="Upload video">
          <UploadPicker
            initialUploads={uploadOverview.recentUploads}
            includeMindSteps={uploadOverview.needsMindCorpus}
          />
        </section>
      </section>
    </AppShell>
  );
}
