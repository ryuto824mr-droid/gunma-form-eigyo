const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

async function searchPlacesAPI(region, keyword) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.displayName,places.websiteUri",
      },
      body: JSON.stringify({ textQuery: `${region} ${keyword}`.trim() }),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const places = data.places || [];

    return places
      .filter(p => p.websiteUri)
      .map(p => ({
        name: p.displayName?.text || p.websiteUri,
        url: p.websiteUri,
        source: "places",
      }));
  } catch {
    return [];
  }
}

module.exports = { searchPlacesAPI };
