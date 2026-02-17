import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { Simcard, SimcardInsert, SimcardUpdate } from '../types/simcard';

export function useSimcards() {
  const [simcards, setSimcards] = useState<Simcard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSimcards = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await supabase
        .from("simcards")
        .select("*")
        .order("created_at", { ascending: false });

      if (fetchError) {
        setError(fetchError.message);
        console.error("Supabase fetch error:", fetchError);
        setSimcards([]);
      } else {
        setSimcards(data ?? []);
      }
    } catch (err) {
      setError("Unexpected error fetching SIM cards");
      console.error(err);
      setSimcards([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSimcards();

    const channel = supabase
      .channel("simcards-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "simcards" }, () => {
        fetchSimcards();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const addSimcard = async (simcard: SimcardInsert) => {
    const { error: insertError } = await supabase.from("simcards").insert(simcard);
    if (insertError) throw insertError;
    await fetchSimcards();
  };

  const updateSimcard = async (id: string, updates: SimcardUpdate) => {
    const { error: updateError } = await supabase
      .from('simcards')
      .update(updates)
      .eq('id', id);
    if (updateError) throw updateError;
    await fetchSimcards();
  };

  const deleteSimcard = async (id: string) => {
    const { error: deleteError } = await supabase.from("simcards").delete().eq("id", id);
    if (deleteError) throw deleteError;
    await fetchSimcards();
  };

  const bulkAddSimcards = async (rows: SimcardInsert[]) => {
    const { error: insertError } = await supabase.from("simcards").insert(rows);
    if (insertError) throw insertError;
    await fetchSimcards();
  };

  return {
    simcards,
    loading,
    error,
    addSimcard,
    updateSimcard,
    deleteSimcard,
    bulkAddSimcards,
    refetch: fetchSimcards,
  };
}
