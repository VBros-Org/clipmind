import { loadAppFrameData, loadRecentUploads } from "../../../lib/app-overview";
import { AppShell } from "../AppShell";
import { requireCreatorSession } from "../app-session";

import { UploadPicker } from "./UploadPicker";
import styles from "./upload.module.css";

export default async function UploadPage() {
  const session = await requireCreatorSession();
  const [frame, recentUploads] = await Promise.all([
    loadAppFrameData(session.creatorId),
    loadRecentUploads(session.creatorId),
  ]);

  return (
    <AppShell activeTab="upload" reviewCount={frame.reviewCount}>
      <section className={styles.stack}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Upload</p>
          <h1 className={styles.title}>Feed the machine</h1>
        </header>

        <section className={styles.uploadCard} aria-label="Upload video">
          <UploadPicker initialUploads={recentUploads} />
        </section>
      </section>
    </AppShell>
  );
}
