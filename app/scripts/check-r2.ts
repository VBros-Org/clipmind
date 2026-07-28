import { createR2Storage } from "../lib/storage";

async function main() {
  const results = await createR2Storage().probeBuckets();

  for (const result of results) {
    console.log(
      `PASSED R2 bucket probe bucket=${result.bucket} key=${result.key} put=get=delete`,
    );
  }
}

main().catch((error: unknown) => {
  console.log("FAILED R2 bucket probe");
  console.error(error);
  process.exitCode = 1;
});
