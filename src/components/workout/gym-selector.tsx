"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Database } from "@/types/database.types";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
} from "@/components/ui/drawer";
import { MapPin } from "lucide-react";

type Gym = Database["public"]["Tables"]["gyms"]["Row"];

interface GymSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (gym: Gym) => void;
}

export function GymSelector({ open, onOpenChange, onSelect }: GymSelectorProps) {
  const [gyms, setGyms] = useState<Gym[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    if (open) {
      supabase
        .from("gyms")
        .select("*")
        .order("is_default", { ascending: false })
        .order("name")
        .then(({ data }) => {
          setGyms(data || []);
          setLoading(false);
        });
    }
  }, [open, supabase]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Select Gym</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 space-y-2 max-h-[50vh] overflow-y-auto">
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl bg-muted" />
              ))}
            </div>
          ) : gyms.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center">
              <MapPin className="mx-auto h-6 w-6 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                No gyms yet. Add one in the Library tab first.
              </p>
            </div>
          ) : (
            gyms.map((gym) => (
              <button
                key={gym.id}
                onClick={() => onSelect(gym)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent active:scale-[0.98]"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{gym.name}</p>
                  {gym.location && (
                    <p className="text-sm text-muted-foreground">{gym.location}</p>
                  )}
                </div>
                {gym.is_default && (
                  <span className="text-xs text-muted-foreground">Default</span>
                )}
              </button>
            ))
          )}
        </div>
        <DrawerFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="h-12">
            Cancel
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
