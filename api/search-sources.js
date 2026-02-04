const SEFARIA_API = 'https://www.sefaria.org/api';

// Source hierarchy for sorting (Chabad-oriented)
const SOURCE_PRIORITY = {
  'Shulchan Arukh HaRav': 1,
  'Shulchan Arukh': 2,
  'Mishneh Torah': 3,
  'Talmud': 4,
  'Torah': 5,
  'Mishnah Berurah': 6,
  'Aruch HaShulchan': 7,
  'Other': 10
};

function getSourceCategory(ref) {
  if (ref.includes('Shulchan Arukh HaRav') || ref.includes("Shulchan Aruch HaRav")) {
    return 'Shulchan Arukh HaRav';
  }
  if (ref.includes('Shulchan Arukh') || ref.includes('Shulchan Aruch')) {
    return 'Shulchan Arukh';
  }
  if (ref.includes('Mishneh Torah') || ref.includes('Rambam')) {
    return 'Mishneh Torah';
  }
  if (ref.includes('Talmud') || ref.includes('Bavli') || ref.includes('Yerushalmi') ||
      // Common tractate names
      ref.match(/^(Berakhot|Shabbat|Eruvin|Pesachim|Yoma|Sukkah|Beitzah|Rosh Hashanah|Taanit|Megillah|Moed Katan|Chagigah|Yevamot|Ketubot|Nedarim|Nazir|Sotah|Gittin|Kiddushin|Bava Kamma|Bava Metzia|Bava Batra|Sanhedrin|Makkot|Shevuot|Avodah Zarah|Horayot|Zevachim|Menachot|Chullin|Bekhorot|Arakhin|Temurah|Keritot|Meilah|Tamid|Middot|Kinnim|Niddah)/i)) {
    return 'Talmud';
  }
  if (ref.match(/^(Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Bereishit|Shemot|Vayikra|Bamidbar|Devarim)/i)) {
    return 'Torah';
  }
  if (ref.includes('Mishnah Berurah')) {
    return 'Mishnah Berurah';
  }
  if (ref.includes('Aruch HaShulchan')) {
    return 'Aruch HaShulchan';
  }
  return 'Other';
}

function sortByHierarchy(sources) {
  return sources.sort((a, b) => {
    const priorityA = SOURCE_PRIORITY[a.category] || 10;
    const priorityB = SOURCE_PRIORITY[b.category] || 10;
    return priorityA - priorityB;
  });
}

async function searchSefaria(query, filters = []) {
  try {
    // Use the search-wrapper endpoint
    const response = await fetch(`${SEFARIA_API}/search-wrapper`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: query,
        type: 'text',
        field: 'naive_lemmatizer', // Better for Hebrew
        slop: 10,
        size: 15,
        filters: filters.length > 0 ? filters : ['Halakhah', 'Talmud', 'Tanakh'],
        filter_fields: ['path'],
        source_proj: true
      })
    });

    if (!response.ok) {
      console.error('Sefaria search failed:', response.status);
      return [];
    }

    const data = await response.json();

    if (!data.hits || !data.hits.hits) {
      return [];
    }

    return data.hits.hits.map(hit => ({
      ref: hit._source?.ref || hit._id,
      snippet: hit._source?.exact || hit._source?.naive_lemmatizer || '',
      score: hit._score,
      path: hit._source?.path || ''
    }));
  } catch (error) {
    console.error('Sefaria search error:', error);
    return [];
  }
}

async function fetchText(ref) {
  try {
    const url = `${SEFARIA_API}/texts/${encodeURIComponent(ref)}?context=0&pad=0`;
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    let english = '';
    let hebrew = '';

    if (data.text) {
      english = Array.isArray(data.text)
        ? data.text.flat(3).filter(t => t).join(' ')
        : data.text;
    }
    if (data.he) {
      hebrew = Array.isArray(data.he)
        ? data.he.flat(3).filter(t => t).join(' ')
        : data.he;
    }

    // Strip HTML and limit length
    english = english.replace(/<[^>]*>/g, '').trim().substring(0, 1500);
    hebrew = hebrew.replace(/<[^>]*>/g, '').trim().substring(0, 1500);

    return {
      ref: ref,
      english,
      hebrew,
      heTitle: data.heRef || ref,
      category: getSourceCategory(ref)
    };
  } catch (error) {
    console.error('Failed to fetch text:', ref, error);
    return null;
  }
}

async function getRelatedSources(ref) {
  try {
    const url = `${SEFARIA_API}/related/${encodeURIComponent(ref)}`;
    const response = await fetch(url);

    if (!response.ok) {
      return [];
    }

    const data = await response.json();

    if (!data.links) {
      return [];
    }

    // Filter for halachic sources and limit
    const halachicLinks = data.links
      .filter(link => {
        const category = link.category || '';
        return category.includes('Halakhah') ||
               category.includes('Commentary') ||
               category.includes('Talmud');
      })
      .slice(0, 10)
      .map(link => link.ref);

    return halachicLinks;
  } catch (error) {
    console.error('Failed to get related sources:', ref, error);
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { searchTerms, sefariaRefs } = req.body;

  if (!searchTerms && !sefariaRefs) {
    return res.status(400).json({ error: 'Search terms or references required' });
  }

  const allSources = new Map(); // Use Map to dedupe by ref
  const errors = [];

  try {
    // 1. First, fetch any directly specified references
    if (sefariaRefs && sefariaRefs.length > 0) {
      const directFetches = sefariaRefs.map(ref => fetchText(ref));
      const directResults = await Promise.all(directFetches);

      for (const result of directResults) {
        if (result) {
          allSources.set(result.ref, result);
        }
      }
    }

    // 2. Search using Hebrew terms (usually more precise)
    if (searchTerms?.hebrew && searchTerms.hebrew.length > 0) {
      for (const term of searchTerms.hebrew.slice(0, 3)) { // Limit to 3 Hebrew searches
        const results = await searchSefaria(term, ['Halakhah']);
        for (const result of results.slice(0, 5)) { // Top 5 per search
          if (!allSources.has(result.ref)) {
            const fullText = await fetchText(result.ref);
            if (fullText) {
              allSources.set(result.ref, fullText);
            }
          }
        }
      }
    }

    // 3. Search using English terms as fallback
    if (searchTerms?.english && searchTerms.english.length > 0 && allSources.size < 5) {
      for (const term of searchTerms.english.slice(0, 2)) { // Limit English searches
        const results = await searchSefaria(term, ['Halakhah', 'Talmud']);
        for (const result of results.slice(0, 3)) {
          if (!allSources.has(result.ref)) {
            const fullText = await fetchText(result.ref);
            if (fullText) {
              allSources.set(result.ref, fullText);
            }
          }
        }
      }
    }

    // 4. Get related sources for top halachic sources found
    const halachicSources = Array.from(allSources.values())
      .filter(s => s.category === 'Shulchan Arukh' || s.category === 'Shulchan Arukh HaRav');

    for (const source of halachicSources.slice(0, 2)) { // Limit related searches
      const related = await getRelatedSources(source.ref);
      for (const relatedRef of related.slice(0, 3)) {
        if (!allSources.has(relatedRef)) {
          const fullText = await fetchText(relatedRef);
          if (fullText) {
            allSources.set(relatedRef, fullText);
          }
        }
      }
    }

    // Convert to array and sort by hierarchy
    const sourcesArray = sortByHierarchy(Array.from(allSources.values()));

    // Organize by category for the response
    const organizedSources = {
      shulchanArukhHaRav: sourcesArray.filter(s => s.category === 'Shulchan Arukh HaRav'),
      shulchanArukh: sourcesArray.filter(s => s.category === 'Shulchan Arukh'),
      mishnehTorah: sourcesArray.filter(s => s.category === 'Mishneh Torah'),
      talmud: sourcesArray.filter(s => s.category === 'Talmud'),
      torah: sourcesArray.filter(s => s.category === 'Torah'),
      acharonim: sourcesArray.filter(s => s.category === 'Mishnah Berurah' || s.category === 'Aruch HaShulchan'),
      other: sourcesArray.filter(s => s.category === 'Other')
    };

    const totalSources = sourcesArray.length;

    return res.status(200).json({
      success: totalSources > 0,
      totalSources,
      sources: organizedSources,
      allSourcesList: sourcesArray, // Flat list sorted by hierarchy
      searchInfo: {
        hebrewTermsUsed: searchTerms?.hebrew || [],
        englishTermsUsed: searchTerms?.english || [],
        directRefsChecked: sefariaRefs || []
      }
    });

  } catch (error) {
    console.error('Search sources error:', error);
    return res.status(500).json({
      error: 'Failed to search sources',
      success: false,
      totalSources: 0
    });
  }
}
