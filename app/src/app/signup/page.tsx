import { SignupFlow } from "./SignupFlow";
import styles from "./signup.module.css";

export default function SignupPage() {
  return (
    <main className={styles.screen}>
      <SignupFlow />
    </main>
  );
}
