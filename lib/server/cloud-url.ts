/** Where Bops Cloud is (cloud/README.md): BOPS_CLOUD_URL points the app at another one (staging, or one running on this Mac). */
export const cloudUrl = () => (process.env.BOPS_CLOUD_URL || "https://bops.orgo.ai/api").replace(/\/+$/, "");
