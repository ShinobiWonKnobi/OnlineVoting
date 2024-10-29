import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Database } from '../lib/database.types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useAuthStore } from '../store/authStore';
import { LoadingSpinner } from './LoadingSpinner';
import { ErrorMessage } from './ErrorMessage';
import toast from 'react-hot-toast';

type Poll = Database['public']['Tables']['polls']['Row'] & {
  options: (Database['public']['Tables']['options']['Row'] & {
    votes: Database['public']['Tables']['votes']['Row'][];
  })[];
};

type PollError = {
  message: string;
  code?: string;
  details?: string;
};

export function PollList() {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PollError | null>(null);
  const [votingInProgress, setVotingInProgress] = useState<string | null>(null);
  const { user, isAdmin } = useAuthStore();

  const fetchPolls = async () => {
    try {
      setLoading(true);
      setError(null);

      const { data: pollsData, error: pollsError } = await supabase
        .from('polls')
        .select('*')
        .order('created_at', { ascending: false });

      if (pollsError) throw pollsError;

      const pollsWithDetails = await Promise.all(
        (pollsData || []).map(async (poll) => {
          const { data: optionsData, error: optionsError } = await supabase
            .from('options')
            .select('*, votes(*)')
            .eq('poll_id', poll.id);

          if (optionsError) throw optionsError;

          return {
            ...poll,
            options: optionsData || [],
          };
        })
      );

      setPolls(pollsWithDetails);
      setError(null);
    } catch (err) {
      console.error('Error fetching polls:', err);
      setError({
        message: 'Failed to load polls. Please try again.',
        code: (err as any)?.code,
        details: (err as any)?.message,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPolls();

    const pollsSubscription = supabase
      .channel('polls-channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'polls' }, () => {
        fetchPolls();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'votes' }, () => {
        fetchPolls();
      })
      .subscribe();

    return () => {
      pollsSubscription.unsubscribe();
    };
  }, []);

  const handleVote = async (pollId: string, optionId: string) => {
    if (!user) {
      toast.error('Please login to vote');
      return;
    }

    if (votingInProgress) return;

    try {
      setVotingInProgress(pollId);

      const { data: existingVote, error: existingVoteError } = await supabase
        .from('votes')
        .select()
        .eq('poll_id', pollId)
        .eq('user_id', user.id)
        .single();

      if (existingVoteError && existingVoteError.code !== 'PGRST116') {
        throw existingVoteError;
      }

      if (existingVote) {
        toast.error('You have already voted on this poll');
        return;
      }

      const { error: voteError } = await supabase.from('votes').insert({
        poll_id: pollId,
        option_id: optionId,
        user_id: user.id,
      });

      if (voteError) throw voteError;

      toast.success('Vote recorded successfully!');
      await fetchPolls();
    } catch (err) {
      console.error('Error voting:', err);
      toast.error('Failed to record vote. Please try again.');
    } finally {
      setVotingInProgress(null);
    }
  };

  if (loading) {
    return <LoadingSpinner message="Loading polls..." />;
  }

  if (error) {
    return (
      <ErrorMessage
        message={error.message}
        action={{
          label: 'Try Again',
          onClick: fetchPolls,
        }}
      />
    );
  }

  if (!polls.length) {
    return (
      <div className="text-center py-12 bg-white rounded-lg shadow-sm">
        <p className="text-gray-500">No polls available yet.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-8 md:grid-cols-2">
      {polls.map((poll) => {
        const data = poll.options.map((option) => ({
          name: option.text,
          votes: option.votes.length,
        }));

        const hasVoted = poll.options.some((option) =>
          option.votes.some((vote) => vote.user_id === user?.id)
        );

        const isPollActive = new Date(poll.ends_at) > new Date() && poll.is_active;

        return (
          <div key={poll.id} className="bg-white p-6 rounded-lg shadow-md">
            <h2 className="text-xl font-bold mb-2">{poll.title}</h2>
            <p className="text-gray-600 mb-4">{poll.description}</p>

            {(isAdmin || hasVoted) && (
              <div className="mb-6">
                <h3 className="text-lg font-semibold mb-2">Results</h3>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" />
                      <YAxis />
                      <Tooltip />
                      <Bar dataKey="votes" fill="#4f46e5" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {poll.options.map((option) => {
                const hasUserVotedForThis = option.votes.some(
                  (vote) => vote.user_id === user?.id
                );

                return (
                  <button
                    key={option.id}
                    onClick={() => handleVote(poll.id, option.id)}
                    disabled={hasVoted || !isPollActive || votingInProgress === poll.id}
                    className={`w-full p-3 text-left border rounded-md transition-colors ${
                      hasUserVotedForThis
                        ? 'bg-indigo-50 border-indigo-200'
                        : isPollActive
                        ? 'hover:bg-gray-50'
                        : 'opacity-75 cursor-not-allowed'
                    }`}
                  >
                    <span className="font-medium">{option.text}</span>
                    {(isAdmin || hasVoted) && (
                      <span className="float-right text-gray-500">
                        {option.votes.length} votes
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="mt-4 text-sm">
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${
                  isPollActive ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                }`}
              >
                {isPollActive ? 'Active' : 'Ended'}
              </span>
              <span className="text-gray-500 ml-2">
                Ends: {new Date(poll.ends_at).toLocaleString()}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}