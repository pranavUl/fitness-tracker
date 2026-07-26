"use client";

import { useState, useEffect } from "react";
import { createClient, getLocalUser } from "@/lib/supabase/client";
import { Database } from "@/types/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  DrawerFooter,
} from "@/components/ui/drawer";
import { Plus, MapPin, Pencil, Trash2, Star } from "lucide-react";

type Gym = Database["public"]["Tables"]["gyms"]["Row"];

export function GymList() {
  const [gyms, setGyms] = useState<Gym[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editingGym, setEditingGym] = useState<Gym | null>(null);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  const supabase = createClient();

  async function loadGyms() {
    const { data } = await supabase
      .from("gyms")
      .select("*")
      .order("is_default", { ascending: false })
      .order("name");
    setGyms(data || []);
    setLoading(false);
  }

  useEffect(() => {
    loadGyms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    setEditingGym(null);
    setName("");
    setLocation("");
    setNotes("");
    setIsDefault(false);
    setOpen(true);
  }

  function openEdit(gym: Gym) {
    setEditingGym(gym);
    setName(gym.name);
    setLocation(gym.location || "");
    setNotes(gym.notes || "");
    setIsDefault(gym.is_default);
    setOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    const user = await getLocalUser(supabase);
    if (!user) return;

    if (editingGym) {
      await supabase
        .from("gyms")
        .update({
          name,
          location: location || null,
          notes: notes || null,
          is_default: isDefault,
        })
        .eq("id", editingGym.id);
    } else {
      await supabase.from("gyms").insert({
        user_id: user.id,
        name,
        location: location || null,
        notes: notes || null,
        is_default: isDefault,
      });
    }

    if (isDefault) {
      const currentId = editingGym?.id;
      await supabase
        .from("gyms")
        .update({ is_default: false })
        .neq("id", currentId || "");
    }

    setSaving(false);
    setOpen(false);
    loadGyms();
  }

  async function handleDelete(id: string) {
    await supabase.from("gyms").delete().eq("id", id);
    loadGyms();
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-xl bg-muted"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <Button onClick={openCreate} className="w-full h-12">
            <Plus className="mr-2 h-4 w-4" />
            Add Gym
          </Button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>
              {editingGym ? "Edit Gym" : "Add Gym"}
            </DrawerTitle>
          </DrawerHeader>
          <div className="space-y-4 px-4">
            <Input
              placeholder="Gym name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-12"
              autoFocus
            />
            <Input
              placeholder="Location (optional)"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="h-12"
            />
            <Textarea
              placeholder="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="h-5 w-5 rounded"
              />
              Default gym (pre-selected when starting workouts)
            </label>
          </div>
          <DrawerFooter>
            <Button
              onClick={handleSave}
              disabled={!name.trim() || saving}
              className="h-12"
            >
              {saving ? "Saving..." : editingGym ? "Update" : "Add Gym"}
            </Button>
            <DrawerClose asChild>
              <Button variant="outline" className="h-12">
                Cancel
              </Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      {gyms.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <MapPin className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            No gyms yet. Add your first gym to get started.
          </p>
        </div>
      ) : (
        gyms.map((gym) => (
          <div
            key={gym.id}
            className="flex items-center gap-3 rounded-xl border border-border bg-card p-4"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-medium truncate">{gym.name}</p>
                {gym.is_default && (
                  <Star className="h-3.5 w-3.5 fill-yellow-500 text-yellow-500 shrink-0" />
                )}
              </div>
              {gym.location && (
                <p className="text-sm text-muted-foreground truncate">
                  {gym.location}
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openEdit(gym)}
                className="h-10 w-10"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleDelete(gym.id)}
                className="h-10 w-10 text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
