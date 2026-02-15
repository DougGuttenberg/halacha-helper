// HalachaHelper - Feedback API endpoint
// Allows rabbis to flag issues with responses

import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

function getSupabase() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase credentials not configured');
  }
  return createClient(supabaseUrl, supabaseKey);
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const supabase = getSupabase();

    // ============================================
    // POST /api/feedback - Submit feedback
    // ============================================
    if (req.method === 'POST') {
      const { action } = req.body;

      // Login action - verify user and return role
      if (action === 'login') {
        const { email } = req.body;

        if (!email) {
          return res.status(400).json({ error: 'Email required' });
        }

        const { data: user, error } = await supabase
          .from('users')
          .select('id, email, name, role')
          .eq('email', email.toLowerCase())
          .single();

        if (error || !user) {
          return res.status(401).json({ error: 'User not found' });
        }

        return res.status(200).json({
          success: true,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role
          }
        });
      }

      // Submit feedback action
      if (action === 'submit') {
        const {
          question,
          response,
          issueType,
          correction,
          notes,
          userId,
          userName
        } = req.body;

        // Validate required fields
        if (!question || !response || !issueType) {
          return res.status(400).json({
            error: 'Missing required fields: question, response, issueType'
          });
        }

        // Validate issue type
        const validIssueTypes = [
          'incorrect_conclusion',
          'misapplied_source',
          'missing_source',
          'reasoning_flaw',
          'other'
        ];

        if (!validIssueTypes.includes(issueType)) {
          return res.status(400).json({
            error: `Invalid issue type. Must be one of: ${validIssueTypes.join(', ')}`
          });
        }

        // Insert feedback
        const { data, error } = await supabase
          .from('feedback')
          .insert([{
            question,
            response,
            issue_type: issueType,
            correction: correction || null,
            notes: notes || null,
            flagged_by: userId || null,
            flagged_by_name: userName || 'Anonymous',
            status: 'pending'
          }])
          .select()
          .single();

        if (error) {
          console.error('Supabase insert error:', error);
          return res.status(500).json({ error: 'Failed to save feedback' });
        }

        return res.status(200).json({
          success: true,
          feedbackId: data.id,
          message: 'Feedback submitted successfully'
        });
      }

      return res.status(400).json({ error: 'Invalid action' });
    }

    // ============================================
    // GET /api/feedback - List feedback (for rabbis)
    // ============================================
    if (req.method === 'GET') {
      const { userId, status } = req.query;

      // Verify user is a rabbi
      if (userId) {
        const { data: user } = await supabase
          .from('users')
          .select('role')
          .eq('id', userId)
          .single();

        if (!user || user.role !== 'rabbi') {
          return res.status(403).json({ error: 'Unauthorized' });
        }
      }

      // Build query
      let query = supabase
        .from('feedback')
        .select('*')
        .order('created_at', { ascending: false });

      if (status) {
        query = query.eq('status', status);
      }

      const { data, error } = await query.limit(50);

      if (error) {
        console.error('Supabase query error:', error);
        return res.status(500).json({ error: 'Failed to fetch feedback' });
      }

      return res.status(200).json({
        success: true,
        feedback: data
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('Feedback API error:', error);
    return res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
}
