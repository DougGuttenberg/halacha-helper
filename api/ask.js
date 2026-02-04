// Orchestrator endpoint - coordinates triage, search, and reasoning

const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000';

async function callTriage(question) {
  const response = await fetch(`${BASE_URL}/api/triage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question })
  });

  if (!response.ok) {
    throw new Error('Triage failed');
  }

  return response.json();
}

async function callSearchSources(searchTerms, sefariaRefs) {
  const response = await fetch(`${BASE_URL}/api/search-sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchTerms, sefariaRefs })
  });

  if (!response.ok) {
    throw new Error('Source search failed');
  }

  return response.json();
}

async function callReason(question, context, triage, sources) {
  const response = await fetch(`${BASE_URL}/api/reason`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, context, triage, sources })
  });

  if (!response.ok) {
    throw new Error('Reasoning failed');
  }

  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, context, sessionState } = req.body;

  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }

  try {
    // If we have a complete session state with triage and context, go straight to search + reason
    if (sessionState?.triageComplete && sessionState?.contextComplete) {
      // Phase 2: Search sources
      const sources = await callSearchSources(
        sessionState.triage.searchTerms,
        sessionState.triage.searchTerms?.sefariaRefs || []
      );

      // Check if we found sources
      if (!sources.success || sources.totalSources === 0) {
        return res.status(200).json({
          phase: 'complete',
          canAnswer: false,
          noSourcesFound: true,
          answer: "I couldn't find relevant halachic sources for this question. This question should be directed to a rabbi who can research the primary sources directly.",
          triage: sessionState.triage,
          sourcesSearched: sources.searchInfo
        });
      }

      // Phase 3: Reason with sources
      const result = await callReason(
        question,
        context || [],
        sessionState.triage,
        sources
      );

      return res.status(200).json({
        phase: 'complete',
        ...result,
        triage: sessionState.triage,
        sourcesFound: sources.totalSources
      });
    }

    // If we have triage but need to collect context answers
    if (sessionState?.triageComplete && !sessionState?.contextComplete) {
      // Context has been provided, now search and reason
      const sources = await callSearchSources(
        sessionState.triage.searchTerms,
        sessionState.triage.searchTerms?.sefariaRefs || []
      );

      if (!sources.success || sources.totalSources === 0) {
        return res.status(200).json({
          phase: 'complete',
          canAnswer: false,
          noSourcesFound: true,
          answer: "I couldn't find relevant halachic sources for this question. This question should be directed to a rabbi who can research the primary sources directly.",
          triage: sessionState.triage,
          sourcesSearched: sources.searchInfo
        });
      }

      const result = await callReason(
        question,
        context || [],
        sessionState.triage,
        sources
      );

      return res.status(200).json({
        phase: 'complete',
        ...result,
        triage: sessionState.triage,
        sourcesFound: sources.totalSources
      });
    }

    // Fresh question - start with triage
    const triage = await callTriage(question);

    // Check if must defer to rabbi immediately
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

    // Check if we need context
    if (triage.needsContext && triage.contextQuestions && triage.contextQuestions.length > 0) {
      return res.status(200).json({
        phase: 'needs_context',
        triage: triage,
        contextQuestions: triage.contextQuestions,
        sessionState: {
          triageComplete: true,
          contextComplete: false,
          triage: triage
        }
      });
    }

    // Check for ambiguity
    if (triage.isAmbiguous && triage.clarifications && triage.clarifications.length > 0) {
      return res.status(200).json({
        phase: 'needs_clarification',
        triage: triage,
        clarifications: triage.clarifications,
        sessionState: {
          triageComplete: true,
          contextComplete: false,
          triage: triage
        }
      });
    }

    // No context needed - proceed directly to search and reason
    const sources = await callSearchSources(
      triage.searchTerms,
      triage.searchTerms?.sefariaRefs || []
    );

    if (!sources.success || sources.totalSources === 0) {
      return res.status(200).json({
        phase: 'complete',
        canAnswer: false,
        noSourcesFound: true,
        answer: "I couldn't find relevant halachic sources for this question in my search. This question should be directed to a rabbi who can research the primary sources directly.",
        triage: triage,
        sourcesSearched: sources.searchInfo
      });
    }

    const result = await callReason(question, [], triage, sources);

    return res.status(200).json({
      phase: 'complete',
      ...result,
      triage: triage,
      sourcesFound: sources.totalSources
    });

  } catch (error) {
    console.error('Orchestration error:', error);
    return res.status(500).json({ error: 'Failed to process question' });
  }
}
