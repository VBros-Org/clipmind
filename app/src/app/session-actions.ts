"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { CREATOR_ACCESS_COOKIE } from "../../lib/review-auth";

export async function logoutCreator() {
  const cookieStore = await cookies();
  cookieStore.delete(CREATOR_ACCESS_COOKIE);
  redirect("/login");
}
