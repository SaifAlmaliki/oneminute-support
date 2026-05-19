import { put, del } from "@vercel/blob";

export async function putOriginal(
  pathname: string,
  body: Buffer | string,
  contentType: string
): Promise<{ url: string; pathname: string }> {
  const blob = await put(pathname, body, {
    access: "public",
    contentType,
    addRandomSuffix: true,
  });
  return { url: blob.url, pathname: blob.pathname };
}

export async function deleteOriginal(pathname: string): Promise<void> {
  await del(pathname);
}
