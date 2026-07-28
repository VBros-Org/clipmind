import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  CREATOR_ACCESS_COOKIE,
  loadCreatorSessionForAccessCode,
} from "../../lib/review-auth";

export async function requireCreatorSession() {
  const cookieStore = await cookies();
  const session = await loadCreatorSessionForAccessCode(
    cookieStore.get(CREATOR_ACCESS_COOKIE)?.value,
  );

  if (!session) {
    redirect("/login");
  }

  return session;
}
