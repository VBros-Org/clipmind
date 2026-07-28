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
          <UploadPicker />
          <p className={styles.explainer}>
            ClipMind finds the moments, ranks them by your taste, and writes your
            captions.
          </p>
          <div className={styles.steps} aria-label="Processing steps">
            {["uploaded", "transcribing", "finding moments", "ranking your Mind", "captions"].map(
              (step) => (
                <span className={styles.step} key={step}>
                  {step}
                </span>
              ),
            )}
          </div>
        </section>

        <section className={styles.recent} aria-labelledby="recent-uploads-title">
          <h2 className={styles.sectionTitle} id="recent-uploads-title">
            Recent uploads
          </h2>
          {recentUploads.length > 0 ? (
            <div className={styles.uploadList}>
              {recentUploads.map((upload) => (
                <article className={styles.uploadRow} key={upload.id}>
                  <div className={styles.uploadCopy}>
                    <h3 className={styles.uploadTitle}>{upload.label}</h3>
                    <p className={styles.uploadMeta}>
                      {upload.clipCount} {upload.clipCount === 1 ? "clip" : "clips"}
                    </p>
                  </div>
                  <span className={styles.statusChip}>{upload.status}</span>
                </article>
              ))}
            </div>
          ) : (
            <p className={styles.emptyText}>No uploads yet.</p>
          )}
        </section>
      </section>
    </AppShell>
  );
}
