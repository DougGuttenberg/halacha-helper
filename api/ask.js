// HalachaHelper - Optimized API endpoint
// Parallel searches, streaming responses, caching

const SEFARIA_API = 'https://www.sefaria.org/api';

// ===========================================
// SIMPLE IN-MEMORY CACHE
// ===========================================
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCacheKey(question) {
  return question.toLowerCase().trim().replace(/[^\w\s]/g, '');
}

function getFromCache(question) {
  const key = getCacheKey(question);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  cache.delete(key);
  return null;
}

function setCache(question, data) {
  const key = getCacheKey(question);
  cache.set(key, { data, timestamp: Date.now() });
  if (cache.size > 100) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// ===========================================
// SOURCE HIERARCHY
// ===========================================
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

// ===========================================
// SEFARIA API FUNCTIONS
// ===========================================
async function searchSefaria(query, filters = []) {
  try {
    const response = await fetch(`${SEFARIA_API}/search-wrapper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query,
        type: 'text',
        field: 'naive_lemmatizer',
        slop: 10,
        size: 10,
        filters: filters.length > 0 ? filters : ['Halakhah', 'Talmud', 'Tanakh'],
        filter_fields: ['path'],
        source_proj: true
      })
    });

    if (!response.ok) return [];
    const data = await response.json();
    if (!data.hits || !data.hits.hits) return [];

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
    if (!response.ok) return null;

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

// OPTIMIZED: Parallel search and fetch
async function searchSourcesParallel(searchTerms, sefariaRefs) {
  const allRefs = new Set();

  try {
    if (sefariaRefs && sefariaRefs.length > 0) {
      sefariaRefs.forEach(ref => allRefs.add(ref));
    }

    // Run ALL searches in parallel
    const searchPromises = [];

    if (searchTerms?.hebrew && searchTerms.hebrew.length > 0) {
      for (const term of searchTerms.hebrew.slice(0, 3)) {
        searchPromises.push(
          searchSefaria(term, ['Halakhah']).then(results =>
            results.slice(0, 4).map(r => r.ref)
          )
        );
      }
    }

    if (searchTerms?.english && searchTerms.english.length > 0) {
      for (const term of searchTerms.english.slice(0, 2)) {
        searchPromises.push(
          searchSefaria(term, ['Halakhah', 'Talmud']).then(results =>
            results.slice(0, 3).map(r => r.ref)
          )
        );
      }
    }

    const searchResults = await Promise.all(searchPromises);

    for (const refs of searchResults) {
      refs.forEach(ref => allRefs.add(ref));
    }

    // Fetch ALL texts in parallel
    const refsToFetch = Array.from(allRefs).slice(0, 12);
    const textResults = await Promise.all(
      refsToFetch.map(ref => fetchText(ref))
    );

    const validSources = textResults.filter(t => t !== null);
    const sourcesArray = sortByHierarchy(validSources);

    return {
      success: sourcesArray.length > 0,
      totalSources: sourcesArray.length,
      allSourcesList: sourcesArray,
      searchInfo: {
        hebrewTermsUsed: searchTerms?.hebrew || [],
        englishTermsUsed: searchTerms?.english || [],
        directRefsChecked: sefariaRefs || []
      }
    };
  } catch (error) {
    console.error('Search sources error:', error);
    return { success: false, totalSources: 0, allSourcesList: [], searchInfo: {} };
  }
}

// ===========================================
// CLAUDE API
// ===========================================
async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Anthropic API error:', error);
    throw new Error('AI service error');
  }

  const data = await response.json();
  const content = data.content[0].text;

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  throw new Error('Failed to parse AI response');
}

// ===========================================
// TRIAGE
// ===========================================
const TRIAGE_PROMPT = `You are a halachic question analyst. Analyze incoming questions about Jewish law.

## Classification
- **questionType**: din|minhag|hashkafa|practical
- **level**: d_oraita|d_rabbanan|minhag|uncertain

## Context Assessment - ALMOST NEVER ASK

**DEFAULT: needsContext: false** - Answer the question directly. Include variations in your answer instead of asking.

**NEVER ask for context when:**
- You can give the general halacha and note "time varies by minhag" in the answer
- The question is yes/no (permitted/forbidden)
- You can mention different opinions in the response itself
- Example: "Can I eat dairy after chicken?" → Answer: "Yes, but you must wait. The waiting time varies by tradition (1/3/6 hours) - follow your family custom or ask your rabbi."

**The ONLY time to set needsContext: true:**
- The user explicitly says "I don't know which tradition I follow"
- Medical/health emergency situations (but usually defer to rabbi instead)

For 99% of questions, just answer directly and include any relevant variations in your response.

## Response Format - Return ONLY valid JSON:
{
  "questionType": "din|minhag|hashkafa|practical",
  "level": "d_oraita|d_rabbanan|minhag|uncertain",
  "domain": {
    "name": "Primary domain",
    "hebrewName": "Hebrew name",
    "shulchanAruchSection": "OC/YD/EH/CM"
  },
  "needsContext": false,
  "contextQuestions": [{"question": "The question text", "why": "Why it matters", "options": ["Option 1", "Option 2"]}],
  "isAmbiguous": false,
  "clarifications": [],
  "mustDeferToRabbi": false,
  "deferReason": null,
  "searchTerms": {
    "hebrew": ["Hebrew terms"],
    "english": ["English terms"],
    "sefariaRefs": ["Specific refs"]
  },
  "initialAssessment": "1-2 sentence summary"
}

IMPORTANT: contextQuestions must be an array of objects with "question", "why", and optional "options" fields. NOT just strings.`;

async function triageQuestion(question) {
  return callClaude(TRIAGE_PROMPT, `Analyze this halachic question:\n\n"${question}"`);
}

// ===========================================
// REASONING
// ===========================================
const REASONING_PROMPT = `You are a halachic reasoning engine. Analyze PROVIDED SOURCE TEXTS and give a ruling.

## CRITICAL RULES
1. ONLY cite sources provided to you
2. If sources don't clearly answer, say so
3. Show reasoning chain through sources

## Source Hierarchy (Chabad-Oriented)
1. Shulchan Arukh HaRav (primary)
2. Shulchan Arukh
3. Mishneh Torah (Rambam)
4. Talmud Bavli
5. Torah
6. Acharonim

## Response Format - Return ONLY valid JSON:
{
  "canAnswer": true|false,
  "answer": "Direct answer (2-3 sentences)",
  "ruling": {
    "summary": "One-sentence ruling",
    "basis": "Primary source",
    "level": "d_oraita|d_rabbanan|minhag",
    "certainty": "definitive|majority_opinion|lenient_opinion|uncertain"
  },
  "reasoning": [
    {
      "level": "Source level",
      "source": "Exact reference",
      "text": "What it says",
      "analysis": "How it applies"
    }
  ],
  "sources": ["Sources cited"],
  "confidence": 0-100,
  "confidenceExplanation": "Why",
  "chabadNote": "Chabad practice or null",
  "domain": { "name": "Domain", "translation": "Translation" },
  "jargon": [{ "term": "Term", "translation": "Meaning", "explanation": "Context" }],
  "consultRabbi": "When to consult"
}`;

async function reasonWithSources(question, context, triage, sources) {
  const sourcesSummary = sources.allSourcesList.map(s => {
    return `### ${s.ref} [${s.category}]
Hebrew: ${s.hebrew ? s.hebrew.substring(0, 500) : 'N/A'}
English: ${s.english ? s.english.substring(0, 500) : 'N/A'}`;
  }).join('\n\n');

  const contextSummary = context && context.length > 0
    ? `User context:\n${context.map(c => `- ${c.question}: ${c.answer}`).join('\n')}`
    : 'No additional context.';

  const userMessage = `## Question
"${question}"

## Analysis
- Type: ${triage.questionType}
- Level: ${triage.level}
- Domain: ${triage.domain?.name || 'Unknown'}

## ${contextSummary}

## Sources (${sources.totalSources} found)

${sourcesSummary}

---
Provide a halachic ruling. ONLY cite sources above.`;

  const result = await callClaude(REASONING_PROMPT, userMessage, 3000);

  result.sourceTexts = {};
  for (const source of sources.allSourcesList) {
    result.sourceTexts[source.ref] = {
      ref: source.ref,
      english: source.english,
      hebrew: source.hebrew,
      found: true
    };
  }

  return result;
}

// ===========================================
// MAIN HANDLER
// ===========================================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, context, sessionState } = req.body;

  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }

  // Check cache first
  const cached = getFromCache(question);
  if (cached && !sessionState) {
    return res.status(200).json({ ...cached, fromCache: true });
  }

  try {
    // If session state complete, search + reason
    if (sessionState?.triageComplete) {
      const sources = await searchSourcesParallel(
        sessionState.triage.searchTerms,
        sessionState.triage.searchTerms?.sefariaRefs || []
      );

      if (!sources.success || sources.totalSources === 0) {
        return res.status(200).json({
          phase: 'complete',
          canAnswer: false,
          noSourcesFound: true,
          answer: "I couldn't find relevant halachic sources. Please consult a rabbi.",
          triage: sessionState.triage
        });
      }

      const result = await reasonWithSources(question, context || [], sessionState.triage, sources);
      const finalResult = {
        phase: 'complete',
        ...result,
        triage: sessionState.triage,
        sourcesFound: sources.totalSources
      };

      setCache(question, finalResult);
      return res.status(200).json(finalResult);
    }

    // Fresh question - triage first
    const triage = await triageQuestion(question);

    if (triage.mustDeferToRabbi) {
      return res.status(200).json({
        phase: 'complete',
        canAnswer: false,
        mustDeferToRabbi: true,
        answer: triage.deferReason || "This question requires personal rabbinic guidance.",
        triage: triage,
        domain: triage.domain
      });
    }

    if (triage.needsContext && triage.contextQuestions?.length > 0) {
      return res.status(200).json({
        phase: 'needs_context',
        triage: triage,
        contextQuestions: triage.contextQuestions,
        sessionState: { triageComplete: true, contextComplete: false, triage }
      });
    }

    if (triage.isAmbiguous && triage.clarifications?.length > 0) {
      return res.status(200).json({
        phase: 'needs_clarification',
        triage: triage,
        clarifications: triage.clarifications,
        sessionState: { triageComplete: true, contextComplete: false, triage }
      });
    }

    // No context needed - proceed directly with PARALLEL search
    const sources = await searchSourcesParallel(
      triage.searchTerms,
      triage.searchTerms?.sefariaRefs || []
    );

    if (!sources.success || sources.totalSources === 0) {
      return res.status(200).json({
        phase: 'complete',
        canAnswer: false,
        noSourcesFound: true,
        answer: "I couldn't find relevant halachic sources. Please consult a rabbi.",
        triage: triage
      });
    }

    const result = await reasonWithSources(question, [], triage, sources);
    const finalResult = {
      phase: 'complete',
      ...result,
      triage: triage,
      sourcesFound: sources.totalSources
    };

    setCache(question, finalResult);
    return res.status(200).json(finalResult);

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: 'Failed to process question: ' + error.message });
  }
}
