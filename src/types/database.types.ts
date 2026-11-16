export type TrackingMode =
  | "reps_weight"
  | "time_weight"
  | "time_only"
  | "reps_only"
  | "reps_assisted"
  | "presence";

export type Equipment =
  | "barbell"
  | "dumbbell"
  | "cable"
  | "machine"
  | "smith_machine"
  | "bodyweight"
  | "band"
  | "kettlebell"
  | "plate"
  | "other";

export type PrType = "WEIGHT" | "1RM" | "VOL" | "REPS" | "DURATION";
export type PrScope = "global" | "per_gym";

export interface Database {
  public: {
    Tables: {
      gyms: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          location: string | null;
          notes: string | null;
          is_default: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          location?: string | null;
          notes?: string | null;
          is_default?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          location?: string | null;
          notes?: string | null;
          is_default?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      exercise_pools: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          parent_pool_id: string | null;
          sort_order: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          parent_pool_id?: string | null;
          sort_order?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          parent_pool_id?: string | null;
          sort_order?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      exercise_definitions: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          pool_id: string | null;
          equipment: Equipment | null;
          supports_modes: TrackingMode[];
          default_mode: TrackingMode;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          pool_id?: string | null;
          equipment?: Equipment | null;
          supports_modes?: TrackingMode[];
          default_mode?: TrackingMode;
          notes?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          pool_id?: string | null;
          equipment?: Equipment | null;
          supports_modes?: TrackingMode[];
          default_mode?: TrackingMode;
          notes?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      gym_exercise_profiles: {
        Row: {
          id: string;
          user_id: string;
          exercise_id: string;
          gym_id: string;
          weight_multiplier: number;
          machine_notes: string | null;
          default_weight: number | null;
          weight_unit: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          exercise_id: string;
          gym_id: string;
          weight_multiplier?: number;
          machine_notes?: string | null;
          default_weight?: number | null;
          weight_unit?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          exercise_id?: string;
          gym_id?: string;
          weight_multiplier?: number;
          machine_notes?: string | null;
          default_weight?: number | null;
          weight_unit?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      workouts: {
        Row: {
          id: string;
          user_id: string;
          gym_id: string | null;
          title: string | null;
          started_at: string;
          finished_at: string | null;
          notes: string | null;
          workout_type: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          gym_id?: string | null;
          title?: string | null;
          started_at?: string;
          finished_at?: string | null;
          notes?: string | null;
          workout_type?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          gym_id?: string | null;
          title?: string | null;
          started_at?: string;
          finished_at?: string | null;
          notes?: string | null;
          workout_type?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      workout_exercises: {
        Row: {
          id: string;
          user_id: string;
          workout_id: string;
          exercise_id: string;
          sort_order: number;
          mode: TrackingMode;
          is_warmup_group: boolean;
          notes: string | null;
          started_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          workout_id: string;
          exercise_id: string;
          sort_order?: number;
          mode?: TrackingMode;
          is_warmup_group?: boolean;
          notes?: string | null;
          started_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          workout_id?: string;
          exercise_id?: string;
          sort_order?: number;
          mode?: TrackingMode;
          is_warmup_group?: boolean;
          notes?: string | null;
          started_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      sets: {
        Row: {
          id: string;
          user_id: string;
          workout_exercise_id: string;
          set_number: number;
          reps: number | null;
          weight: number | null;
          weight_unit: string;
          duration_seconds: number | null;
          is_warmup: boolean;
          is_assisted: boolean;
          note: string | null;
          completed_at: string | null;
          e1rm: number | null;
          rest_seconds: number | null;
          is_pr_weight: boolean;
          is_pr_1rm: boolean;
          is_pr_volume: boolean;
          is_pr_reps: boolean;
          is_pr_duration: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          workout_exercise_id: string;
          set_number?: number;
          reps?: number | null;
          weight?: number | null;
          weight_unit?: string;
          duration_seconds?: number | null;
          is_warmup?: boolean;
          is_assisted?: boolean;
          note?: string | null;
          completed_at?: string | null;
          e1rm?: number | null;
          rest_seconds?: number | null;
          is_pr_weight?: boolean;
          is_pr_1rm?: boolean;
          is_pr_volume?: boolean;
          is_pr_reps?: boolean;
          is_pr_duration?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          workout_exercise_id?: string;
          set_number?: number;
          reps?: number | null;
          weight?: number | null;
          weight_unit?: string;
          duration_seconds?: number | null;
          is_warmup?: boolean;
          is_assisted?: boolean;
          note?: string | null;
          completed_at?: string | null;
          e1rm?: number | null;
          rest_seconds?: number | null;
          is_pr_weight?: boolean;
          is_pr_1rm?: boolean;
          is_pr_volume?: boolean;
          is_pr_reps?: boolean;
          is_pr_duration?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      daily_tracking: {
        Row: {
          id: string;
          user_id: string;
          date: string;
          protein_grams: number | null;
          carbs_grams: number | null;
          morning_weight: number | null;
          journal: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          date: string;
          protein_grams?: number | null;
          carbs_grams?: number | null;
          morning_weight?: number | null;
          journal?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          date?: string;
          protein_grams?: number | null;
          carbs_grams?: number | null;
          morning_weight?: number | null;
          journal?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      run_sessions: {
        Row: {
          id: string;
          user_id: string;
          strava_id: number | null;
          source: string;
          name: string | null;
          run_pool: string | null;
          run_workout: string | null;
          distance_meters: number | null;
          duration_seconds: number | null;
          avg_pace: number | null;
          avg_heart_rate: number | null;
          completed: boolean;
          notes: string | null;
          started_at: string | null;
          polyline: string | null;
          raw_data: Record<string, unknown> | null;
          synced_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          strava_id?: number | null;
          source?: string;
          name?: string | null;
          run_pool?: string | null;
          run_workout?: string | null;
          distance_meters?: number | null;
          duration_seconds?: number | null;
          avg_pace?: number | null;
          avg_heart_rate?: number | null;
          completed?: boolean;
          notes?: string | null;
          started_at?: string | null;
          polyline?: string | null;
          raw_data?: Record<string, unknown> | null;
          synced_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          strava_id?: number | null;
          source?: string;
          name?: string | null;
          run_pool?: string | null;
          run_workout?: string | null;
          distance_meters?: number | null;
          duration_seconds?: number | null;
          avg_pace?: number | null;
          avg_heart_rate?: number | null;
          completed?: boolean;
          notes?: string | null;
          started_at?: string | null;
          polyline?: string | null;
          raw_data?: Record<string, unknown> | null;
          synced_at?: string;
        };
        Relationships: [];
      };
      google_calendar_tokens: {
        Row: {
          id: string;
          user_id: string;
          access_token: string;
          refresh_token: string;
          expires_at: number;
          calendar_id: string | null;
          calendar_name: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          access_token: string;
          refresh_token: string;
          expires_at: number;
          calendar_id?: string | null;
          calendar_name?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          access_token?: string;
          refresh_token?: string;
          expires_at?: number;
          calendar_id?: string | null;
          calendar_name?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      strava_tokens: {
        Row: {
          athlete_id: number;
          access_token: string;
          refresh_token: string;
          expires_at: number;
          athlete_data: Record<string, unknown> | null;
          updated_at: string;
        };
        Insert: {
          athlete_id: number;
          access_token: string;
          refresh_token: string;
          expires_at: number;
          athlete_data?: Record<string, unknown> | null;
          updated_at?: string;
        };
        Update: {
          athlete_id?: number;
          access_token?: string;
          refresh_token?: string;
          expires_at?: number;
          athlete_data?: Record<string, unknown> | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      personal_records: {
        Row: {
          id: string;
          user_id: string;
          exercise_id: string;
          pr_type: string;
          is_primary: boolean;
          value: number;
          value_unit: string;
          previous_value: number | null;
          set_id: string | null;
          workout_id: string | null;
          gym_id: string | null;
          pr_scope: string;
          achieved_at: string;
          context_json: Record<string, unknown> | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          exercise_id: string;
          pr_type: string;
          is_primary?: boolean;
          value: number;
          value_unit?: string;
          previous_value?: number | null;
          set_id?: string | null;
          workout_id?: string | null;
          gym_id?: string | null;
          pr_scope?: string;
          achieved_at?: string;
          context_json?: Record<string, unknown> | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          exercise_id?: string;
          pr_type?: string;
          is_primary?: boolean;
          value?: number;
          value_unit?: string;
          previous_value?: number | null;
          set_id?: string | null;
          workout_id?: string | null;
          gym_id?: string | null;
          pr_scope?: string;
          achieved_at?: string;
          context_json?: Record<string, unknown> | null;
          created_at?: string;
        };
        Relationships: [];
      };
      pr_snapshots: {
        Row: {
          id: string;
          user_id: string;
          exercise_id: string;
          pr_type: string;
          is_primary: boolean;
          value: number;
          value_unit: string;
          previous_value: number | null;
          set_id: string | null;
          workout_id: string | null;
          gym_id: string | null;
          pr_scope: string;
          achieved_at: string;
          context_json: Record<string, unknown> | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          exercise_id: string;
          pr_type: string;
          is_primary?: boolean;
          value: number;
          value_unit?: string;
          previous_value?: number | null;
          set_id?: string | null;
          workout_id?: string | null;
          gym_id?: string | null;
          pr_scope?: string;
          achieved_at?: string;
          context_json?: Record<string, unknown> | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          exercise_id?: string;
          pr_type?: string;
          is_primary?: boolean;
          value?: number;
          value_unit?: string;
          previous_value?: number | null;
          set_id?: string | null;
          workout_id?: string | null;
          gym_id?: string | null;
          pr_scope?: string;
          achieved_at?: string;
          context_json?: Record<string, unknown> | null;
          created_at?: string;
        };
        Relationships: [];
      };
      run_pool_workouts: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          pool: string;
          surface: string;
          footwear: string;
          description: string | null;
          duration_est: string | null;
          difficulty: string | null;
          strava_tracked: boolean;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          user_id: string;
          name: string;
          pool: string;
          surface?: string;
          footwear?: string;
          description?: string | null;
          duration_est?: string | null;
          difficulty?: string | null;
          strava_tracked?: boolean;
          notes?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          pool?: string;
          surface?: string;
          footwear?: string;
          description?: string | null;
          duration_est?: string | null;
          difficulty?: string | null;
          strava_tracked?: boolean;
          notes?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      tracking_mode: TrackingMode;
      equipment: Equipment;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}
