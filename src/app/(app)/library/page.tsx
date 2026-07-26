"use client";

import { useState } from "react";
import { ExerciseList } from "@/components/library/exercise-list";
import { GymList } from "@/components/library/gym-list";
import { RunPoolList } from "@/components/library/run-pool-list";
import { cn } from "@/lib/utils";

const tabs = ["Exercises", "Runs", "Gyms"] as const;

export default function LibraryPage() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>(
    "Exercises"
  );

  return (
    <div className="mx-auto max-w-lg px-4 pt-6 pb-4">
      <h1 className="text-2xl font-bold tracking-tight">Library</h1>

      {/* Tab switcher */}
      <div className="mt-4 flex rounded-xl bg-muted p-1">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "flex-1 rounded-lg py-2 text-sm font-medium transition-colors",
              activeTab === tab
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="mt-4">
        {activeTab === "Exercises" ? (
          <ExerciseList />
        ) : activeTab === "Runs" ? (
          <RunPoolList />
        ) : (
          <GymList />
        )}
      </div>
    </div>
  );
}
