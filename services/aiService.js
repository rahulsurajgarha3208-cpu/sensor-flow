// Talks to the Gemini API. The API key stays here on the server.
// Uses the built-in fetch of Node 18+, so no extra library is needed.

export async function generateExplanation(prompt) {
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  // Gemini 2.5 Flash "thinks" before answering and those hidden tokens count against
  // maxOutputTokens, which can leave an empty answer. Turn thinking off where allowed.
  const generationConfig = { temperature: 0.3, maxOutputTokens: 1024 };
  if (/3\.6-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else generationConfig.maxOutputTokens = 2048; // newer models may spend some tokens thinking

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(20000), // give up after 20 seconds
    });
  } catch (err) {
    const timedOut = err.name === "TimeoutError";
    throw makeError(
      502,
      timedOut ? "The AI service took too long to respond" : "Could not reach the AI service"
    );
  }

  if (!response.ok) {
    // Google explains the problem in the body, e.g. "API key not valid" or "models/x is not found"
    let reason = "";
    try {
      reason = (await response.json())?.error?.message || "";
    } catch {
      // no JSON body
    }
    console.error(`Gemini error ${response.status} (model ${model}): ${reason}`);
    const detail = reason ? ` Google says: ${reason.slice(0, 200)}` : "";
    if (response.status === 429) {
      throw makeError(429, "AI rate limit reached. Please wait a minute and try again.");
    }
    if (response.status === 404) {
      throw makeError(502, `Model "${model}" was not found for your key. Set GEMINI_MODEL in backend/.env to a model you can use.${detail}`);
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw makeError(502, `The AI service rejected the request (${response.status}).${detail}`);
    }
    throw makeError(502, `The AI service returned an error (${response.status}).${detail}`);
  }

  const result = await response.json();
  const parts = result?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part.text || "").join("").trim();
  if (!text) {
    const blocked = result?.promptFeedback?.blockReason || result?.candidates?.[0]?.finishReason === "SAFETY";
    throw makeError(502, blocked
      ? "The AI service declined to answer this request."
      : "The AI service returned an empty answer. Please try again.");
  }
  return { text, model };
}

function makeError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
