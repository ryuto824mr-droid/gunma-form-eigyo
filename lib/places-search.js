const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

// results: 通常の呼び出し互換のため配列そのまま
// debug: has_key/key_length/status/error等の診断情報(APIキーの値自体は含めない)
async function searchPlacesAPI(region, keyword) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const debug = { has_key: !!apiKey, key_length: apiKey ? apiKey.length : 0 };

  if (!apiKey) {
    return Object.assign([], { debug });
  }

  try {
    const textQuery = `${region} ${keyword}`.trim();
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.displayName,places.websiteUri",
      },
      body: JSON.stringify({ textQuery }),
    });

    debug.status = res.status;
    debug.text_query = textQuery;

    if (!res.ok) {
      debug.error = (await res.text()).slice(0, 300);
      return Object.assign([], { debug });
    }

    const data = await res.json();
    const places = data.places || [];
    debug.places_returned = places.length;
    debug.places_with_website = places.filter(p => p.websiteUri).length;

    const results = places
      .filter(p => p.websiteUri)
      .map(p => ({
        name: p.displayName?.text || p.websiteUri,
        url: p.websiteUri,
        source: "places",
      }));
    return Object.assign(results, { debug });
  } catch (err) {
    debug.error = err.message;
    return Object.assign([], { debug });
  }
}

module.exports = { searchPlacesAPI };
