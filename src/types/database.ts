// This file should be regenerated with: npx supabase gen types typescript
// For now, manually define the types matching our schema.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ExperimentParameterType = "number" | "string" | "enum";

export interface ExperimentParameterSpec {
  key: string;
  type: ExperimentParameterType;
  default?: string | number | null;
  options?: string[];
}

export interface ExperimentChecklistItem {
  item: string;
  required: boolean;
  checked?: boolean;
  checked_at?: string | null;
}

export type ExperimentMode = "offline" | "online" | "hybrid";

// Mirror of the persisted JSONB shape — see
// `src/lib/experiments/code-analysis-schema.ts` for the zod source of
// truth. Kept structural here so the DB types file does not pull in zod
// at type-only import sites.
export interface OfflineCodeAnalysisColumn {
  code_excerpt: string | null;
  code_filename: string | null;
  code_lang: string | null;
  analyzed_at: string | null;
  model: string | null;
  // Loose `unknown` here to avoid duplicating the deep CodeAnalysis
  // shape — consumers cast through CodeAnalysisSchema when reading.
  heuristic: unknown;
  ai: unknown;
  overrides: unknown;
  merged: unknown;
}

export interface OnlineRuntimeConfig {
  // Researcher-provided URL to the experiment JavaScript file(s). Loaded
  // as a <script> inside the /run shell's sandbox iframe.
  entry_url: string;
  // Subresource Integrity hash, e.g. "sha384-…". When set, the shim loads
  // the script with `<script integrity="…">` so a silently-swapped CDN
  // payload can't run. Researchers compute this once per release.
  entry_url_sri?: string | null;
  // Optional shape hints for the /run shell's progress UI.
  trial_count?: number;
  block_count?: number;
  estimated_minutes?: number;
  // Format of the completion code shown to the participant:
  //   'uuid'            — default, crypto-random UUID
  //   'alphanumeric:N'  — N-character random [A-Z0-9], e.g. 'alphanumeric:8'
  // Kept as `string` here so zod's regex-narrowed literal still type-checks;
  // the ingestion route validates the shape at runtime.
  completion_token_format?: string;
  // Pre-run environment check. If set, /run shell shows a preflight screen
  // before loading the researcher's JS.
  preflight?: {
    min_width?: number;
    min_height?: number;
    require_keyboard?: boolean;
    require_audio?: boolean;
    // Free-form researcher instructions ("조용한 방에서 진행해주세요").
    instructions?: string;
  };
  // Condition assignment spec. Server computes the condition deterministically
  // from subject_number at session-endpoint time.
  counterbalance_spec?:
    | { kind: "latin_square"; conditions: string[] }
    | { kind: "block_rotation"; conditions: string[]; block_size?: number }
    | { kind: "random"; conditions: string[]; seed?: string };
  // Attention checks inserted by the shell between blocks. `position` is
  // 'after_block:N' (0-indexed) or 'random' (randomly placed among blocks).
  attention_checks?: Array<{
    question: string;
    kind: "yes_no" | "single_choice";
    options?: string[];
    correct_answer: string;
    position: `after_block:${number}` | "random";
  }>;
  // Cross-study exclusion. If set, the booking API refuses any participant
  // (matched by phone + email) who has a prior confirmed/running/completed
  // booking on ANY of these experiments. Online/hybrid only.
  exclude_experiment_ids?: string[];
}

export type OnlineScreenerKind =
  | "yes_no"
  | "numeric"
  | "single_choice"
  | "multi_choice";

export interface OnlineScreenerValidation {
  required_answer?: boolean; // yes_no
  min?: number; // numeric
  max?: number; // numeric
  integer?: boolean; // numeric
  options?: string[]; // single / multi
  accepted?: string[]; // single: one-of; multi: all-must-include
  min_selected?: number; // multi
  max_selected?: number; // multi
  accepted_all?: string[]; // multi: allow-any-of-these-set
}

// participant_class enum — matches 00025 migration.
export type ParticipantClass = "newbie" | "royal" | "blacklist" | "vip";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          display_name: string | null;
          role: "admin" | "researcher";
          disabled: boolean;
          phone: string;
          contact_email: string;
          notion_member_page_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          display_name?: string | null;
          role?: "admin" | "researcher";
          disabled?: boolean;
          phone?: string;
          contact_email?: string;
          notion_member_page_id?: string | null;
        };
        Update: {
          email?: string;
          display_name?: string | null;
          role?: "admin" | "researcher";
          disabled?: boolean;
          phone?: string;
          contact_email?: string;
          notion_member_page_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      booking_integrations: {
        Row: {
          id: string;
          booking_id: string;
          integration_type:
            | "gcal"
            | "notion"
            | "email"
            | "sms"
            | "notion_experiment"
            | "notion_survey"
            | "status_email"
            | "status_sms";
          status: "pending" | "completed" | "failed" | "skipped";
          attempts: number;
          last_error: string | null;
          external_id: string | null;
          created_at: string;
          processed_at: string | null;
        };
        Insert: {
          id?: string;
          booking_id: string;
          integration_type:
            | "gcal"
            | "notion"
            | "email"
            | "sms"
            | "notion_experiment"
            | "notion_survey"
            | "status_email"
            | "status_sms";
          status?: "pending" | "completed" | "failed" | "skipped";
          attempts?: number;
          last_error?: string | null;
          external_id?: string | null;
          processed_at?: string | null;
        };
        Update: {
          status?: "pending" | "completed" | "failed" | "skipped";
          attempts?: number;
          last_error?: string | null;
          external_id?: string | null;
          processed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "booking_integrations_booking_id_fkey";
            columns: ["booking_id"];
            isOneToOne: false;
            referencedRelation: "bookings";
            referencedColumns: ["id"];
          },
        ];
      };
      registration_requests: {
        Row: {
          id: string;
          username: string;
          display_name: string;
          password_cipher: string;
          password_iv: string;
          password_tag: string;
          status: "pending" | "approved" | "rejected";
          requested_at: string;
          processed_at: string | null;
          processed_by: string | null;
          rejection_reason: string | null;
          phone: string | null;
          contact_email: string;
        };
        Insert: {
          id?: string;
          username: string;
          display_name: string;
          password_cipher: string;
          password_iv: string;
          password_tag: string;
          status?: "pending" | "approved" | "rejected";
          requested_at?: string;
          processed_at?: string | null;
          processed_by?: string | null;
          rejection_reason?: string | null;
          phone?: string | null;
          contact_email: string;
        };
        Update: {
          status?: "pending" | "approved" | "rejected";
          processed_at?: string | null;
          processed_by?: string | null;
          rejection_reason?: string | null;
          password_cipher?: string;
          password_iv?: string;
          password_tag?: string;
        };
        Relationships: [];
      };
      experiment_locations: {
        Row: {
          id: string;
          name: string;
          address_lines: string[];
          naver_url: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          address_lines?: string[];
          naver_url?: string | null;
          created_by?: string | null;
        };
        Update: {
          name?: string;
          address_lines?: string[];
          naver_url?: string | null;
        };
        Relationships: [];
      };
      experiment_manual_blocks: {
        Row: {
          id: string;
          experiment_id: string;
          block_start: string;
          block_end: string;
          reason: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          experiment_id: string;
          block_start: string;
          block_end: string;
          reason?: string | null;
          created_by?: string | null;
        };
        Update: {
          block_start?: string;
          block_end?: string;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "experiment_manual_blocks_experiment_id_fkey";
            columns: ["experiment_id"];
            isOneToOne: false;
            referencedRelation: "experiments";
            referencedColumns: ["id"];
          },
        ];
      };
      experiments: {
        Row: {
          id: string;
          lab_id: string;
          title: string;
          description: string | null;
          start_date: string;
          end_date: string;
          session_duration_minutes: number;
          max_participants_per_slot: number;
          participation_fee: number;
          session_type: "single" | "multi";
          required_sessions: number;
          daily_start_time: string;
          daily_end_time: string;
          break_between_slots_minutes: number;
          status: "draft" | "active" | "completed" | "cancelled";
          google_calendar_id: string | null;
          irb_document_url: string | null;
          precautions: Array<{ question: string; required_answer: boolean }>;
          categories: string[];
          location_id: string | null;
          location: "slab" | "snubic" | null;
          weekdays?: number[];
          registration_deadline?: string | null;
          auto_lock?: boolean;
          subject_start_number?: number;
          reminder_day_before_enabled: boolean;
          reminder_day_before_time: string;
          reminder_day_of_enabled: boolean;
          reminder_day_of_time: string;
          project_name?: string | null;
          code_repo_url: string | null;
          data_path: string | null;
          parameter_schema: ExperimentParameterSpec[];
          pre_experiment_checklist: ExperimentChecklistItem[];
          checklist_completed_at: string | null;
          notion_experiment_page_id: string | null;
          notion_experiment_sync_attempted_at: string | null;
          notion_project_page_id: string | null;
          protocol_version: string | null;
          experiment_mode: ExperimentMode;
          online_runtime_config: OnlineRuntimeConfig | null;
          // Heuristic + AI + user-override extracted metadata for the
          // experimenter's offline experiment code (migration 00049).
          // Shape lives in src/lib/experiments/code-analysis-schema.ts.
          offline_code_analysis: OfflineCodeAnalysisColumn | null;
          data_consent_required: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          lab_id?: string;
          title: string;
          description?: string | null;
          start_date: string;
          end_date: string;
          session_duration_minutes: number;
          max_participants_per_slot?: number;
          participation_fee?: number;
          session_type?: "single" | "multi";
          required_sessions?: number;
          daily_start_time: string;
          daily_end_time: string;
          break_between_slots_minutes?: number;
          status?: "draft" | "active" | "completed" | "cancelled";
          google_calendar_id?: string | null;
          irb_document_url?: string | null;
          precautions?: Array<{ question: string; required_answer: boolean }>;
          categories?: string[];
          location?: "slab" | "snubic" | null;
          location_id?: string | null;
          weekdays?: number[];
          registration_deadline?: string | null;
          auto_lock?: boolean;
          subject_start_number?: number;
          reminder_day_before_enabled?: boolean;
          reminder_day_before_time?: string;
          reminder_day_of_enabled?: boolean;
          reminder_day_of_time?: string;
          project_name?: string | null;
          code_repo_url?: string | null;
          data_path?: string | null;
          parameter_schema?: ExperimentParameterSpec[];
          pre_experiment_checklist?: ExperimentChecklistItem[];
          checklist_completed_at?: string | null;
          notion_experiment_page_id?: string | null;
          notion_experiment_sync_attempted_at?: string | null;
          notion_project_page_id?: string | null;
          protocol_version?: string | null;
          experiment_mode?: ExperimentMode;
          online_runtime_config?: OnlineRuntimeConfig | null;
          offline_code_analysis?: OfflineCodeAnalysisColumn | null;
          data_consent_required?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          lab_id?: string;
          title?: string;
          description?: string | null;
          start_date?: string;
          end_date?: string;
          session_duration_minutes?: number;
          max_participants_per_slot?: number;
          participation_fee?: number;
          session_type?: "single" | "multi";
          required_sessions?: number;
          daily_start_time?: string;
          daily_end_time?: string;
          break_between_slots_minutes?: number;
          status?: "draft" | "active" | "completed" | "cancelled";
          google_calendar_id?: string | null;
          irb_document_url?: string | null;
          precautions?: Array<{ question: string; required_answer: boolean }>;
          categories?: string[];
          location?: "slab" | "snubic" | null;
          location_id?: string | null;
          weekdays?: number[];
          registration_deadline?: string | null;
          auto_lock?: boolean;
          subject_start_number?: number;
          reminder_day_before_enabled?: boolean;
          reminder_day_before_time?: string;
          reminder_day_of_enabled?: boolean;
          reminder_day_of_time?: string;
          project_name?: string | null;
          code_repo_url?: string | null;
          data_path?: string | null;
          parameter_schema?: ExperimentParameterSpec[];
          pre_experiment_checklist?: ExperimentChecklistItem[];
          checklist_completed_at?: string | null;
          notion_experiment_page_id?: string | null;
          notion_experiment_sync_attempted_at?: string | null;
          notion_project_page_id?: string | null;
          protocol_version?: string | null;
          experiment_mode?: ExperimentMode;
          online_runtime_config?: OnlineRuntimeConfig | null;
          offline_code_analysis?: OfflineCodeAnalysisColumn | null;
          data_consent_required?: boolean;
          created_by?: string | null;
        };
        Relationships: [];
      };
      participants: {
        Row: {
          id: string;
          name: string;
          phone: string;
          email: string;
          gender: "male" | "female" | "other" | null;
          birthdate: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          phone: string;
          email: string;
          gender?: "male" | "female" | "other" | null;
          birthdate: string;
          created_at?: string;
        };
        Update: {
          name?: string;
          phone?: string;
          email?: string;
          gender?: "male" | "female" | "other" | null;
          birthdate?: string;
        };
        Relationships: [];
      };
      bookings: {
        Row: {
          id: string;
          experiment_id: string;
          participant_id: string;
          slot_start: string;
          slot_end: string;
          session_number: number;
          subject_number: number | null;
          booking_group_id: string | null;
          status: "confirmed" | "cancelled" | "completed" | "no_show" | "running";
          google_event_id: string | null;
          notion_page_id: string | null;
          auto_completed_at: string | null;
          // Roadmap C4 (migration 00047). Default values pre-migration
          // rollback: exclusion_flag=false, data_quality='good'.
          exclusion_flag: boolean;
          exclusion_reason: string | null;
          data_quality: "good" | "flag" | "exclude";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          experiment_id: string;
          participant_id: string;
          slot_start: string;
          slot_end: string;
          session_number?: number;
          subject_number?: number | null;
          booking_group_id?: string | null;
          status?: "confirmed" | "cancelled" | "completed" | "no_show" | "running";
          google_event_id?: string | null;
          notion_page_id?: string | null;
          auto_completed_at?: string | null;
          exclusion_flag?: boolean;
          exclusion_reason?: string | null;
          data_quality?: "good" | "flag" | "exclude";
        };
        Update: {
          slot_start?: string;
          slot_end?: string;
          session_number?: number;
          subject_number?: number | null;
          status?: "confirmed" | "cancelled" | "completed" | "no_show" | "running";
          google_event_id?: string | null;
          notion_page_id?: string | null;
          auto_completed_at?: string | null;
          exclusion_flag?: boolean;
          exclusion_reason?: string | null;
          data_quality?: "good" | "flag" | "exclude";
        };
        Relationships: [
          {
            foreignKeyName: "bookings_experiment_id_fkey";
            columns: ["experiment_id"];
            isOneToOne: false;
            referencedRelation: "experiments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bookings_participant_id_fkey";
            columns: ["participant_id"];
            isOneToOne: false;
            referencedRelation: "participants";
            referencedColumns: ["id"];
          },
        ];
      };
      reminders: {
        Row: {
          id: string;
          booking_id: string;
          reminder_type: "day_before_evening" | "day_of_morning";
          scheduled_at: string;
          sent_at: string | null;
          status: "pending" | "sent" | "failed";
          channel: "email" | "sms" | "both";
          created_at: string;
        };
        Insert: {
          id?: string;
          booking_id: string;
          reminder_type: "day_before_evening" | "day_of_morning";
          scheduled_at: string;
          status?: "pending" | "sent" | "failed";
          channel?: "email" | "sms" | "both";
        };
        Update: {
          status?: "pending" | "sent" | "failed";
          sent_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "reminders_booking_id_fkey";
            columns: ["booking_id"];
            isOneToOne: false;
            referencedRelation: "bookings";
            referencedColumns: ["id"];
          },
        ];
      };
      experiment_run_progress: {
        Row: {
          id: string;
          booking_id: string;
          token_hash: string;
          token_issued_at: string;
          token_revoked_at: string | null;
          blocks_submitted: number;
          last_block_at: string | null;
          completion_code: string | null;
          completion_code_issued_at: string | null;
          verified_at: string | null;
          verified_by: string | null;
          burst_window_start: string;
          burst_count: number;
          minute_window_start: string;
          minute_count: number;
          verify_attempts: number;
          verify_locked_until: string | null;
          is_pilot: boolean;
          condition_assignment: string | null;
          attention_fail_count: number;
          behavior_signals: Record<string, unknown>;
          entry_url_sri: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          booking_id: string;
          token_hash: string;
          token_issued_at?: string;
          token_revoked_at?: string | null;
          blocks_submitted?: number;
          last_block_at?: string | null;
          completion_code?: string | null;
          completion_code_issued_at?: string | null;
          verified_at?: string | null;
          verified_by?: string | null;
          verify_attempts?: number;
          verify_locked_until?: string | null;
          is_pilot?: boolean;
          condition_assignment?: string | null;
          attention_fail_count?: number;
          behavior_signals?: Record<string, unknown>;
          entry_url_sri?: string | null;
        };
        Update: {
          token_hash?: string;
          token_revoked_at?: string | null;
          blocks_submitted?: number;
          last_block_at?: string | null;
          completion_code?: string | null;
          completion_code_issued_at?: string | null;
          verified_at?: string | null;
          verified_by?: string | null;
          verify_attempts?: number;
          verify_locked_until?: string | null;
          is_pilot?: boolean;
          condition_assignment?: string | null;
          attention_fail_count?: number;
          behavior_signals?: Record<string, unknown>;
          entry_url_sri?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "experiment_run_progress_booking_id_fkey";
            columns: ["booking_id"];
            isOneToOne: true;
            referencedRelation: "bookings";
            referencedColumns: ["id"];
          },
        ];
      };
      experiment_online_screeners: {
        Row: {
          id: string;
          experiment_id: string;
          position: number;
          kind: OnlineScreenerKind;
          question: string;
          help_text: string | null;
          validation_config: OnlineScreenerValidation;
          required: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          experiment_id: string;
          position: number;
          kind: OnlineScreenerKind;
          question: string;
          help_text?: string | null;
          validation_config?: OnlineScreenerValidation;
          required?: boolean;
        };
        Update: {
          position?: number;
          kind?: OnlineScreenerKind;
          question?: string;
          help_text?: string | null;
          validation_config?: OnlineScreenerValidation;
          required?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "experiment_online_screeners_experiment_id_fkey";
            columns: ["experiment_id"];
            isOneToOne: false;
            referencedRelation: "experiments";
            referencedColumns: ["id"];
          },
        ];
      };
      experiment_online_screener_responses: {
        Row: {
          id: string;
          booking_id: string;
          screener_id: string;
          answer: Json;
          passed: boolean;
          submitted_at: string;
        };
        Insert: {
          id?: string;
          booking_id: string;
          screener_id: string;
          answer: Json;
          passed: boolean;
        };
        Update: {
          answer?: Json;
          passed?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "experiment_online_screener_responses_booking_id_fkey";
            columns: ["booking_id"];
            isOneToOne: false;
            referencedRelation: "bookings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "experiment_online_screener_responses_screener_id_fkey";
            columns: ["screener_id"];
            isOneToOne: false;
            referencedRelation: "experiment_online_screeners";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_freebusy_cache: {
        Row: {
          calendar_id: string;
          range_from: string;
          range_to: string;
          busy_intervals: Array<{ start: string; end: string }>;
          fetched_at: string;
        };
        Insert: {
          calendar_id: string;
          range_from: string;
          range_to: string;
          busy_intervals: Array<{ start: string; end: string }>;
          fetched_at?: string;
        };
        Update: {
          busy_intervals?: Array<{ start: string; end: string }>;
          fetched_at?: string;
        };
        Relationships: [];
      };
      participant_payment_info: {
        Row: {
          id: string;
          participant_id: string;
          experiment_id: string;
          booking_group_id: string;
          rrn_cipher: string | null;
          rrn_iv: string | null;
          rrn_tag: string | null;
          rrn_key_version: number;
          bank_name: string | null;
          account_number: string | null;
          account_holder: string | null;
          institution: string | null;
          // Participant-confirmed contact snapshot (migration 00050).
          name_override: string | null;
          email_override: string | null;
          phone: string | null;
          // Payment-info dispatch state (migration 00051).
          payment_link_sent_at: string | null;
          payment_link_attempts: number;
          payment_link_last_error: string | null;
          payment_link_last_attempt_at: string | null;
          // Token preservation across auto-dispatch (migration 00052).
          token_cipher: string | null;
          token_iv: string | null;
          token_tag: string | null;
          token_key_version: number | null;
          payment_link_first_opened_at: string | null;
          // Dispatch lock-acquire lease (migration 00053).
          payment_link_dispatch_lock_until: string | null;
          signature_path: string | null;
          signed_at: string | null;
          bankbook_path: string | null;
          bankbook_mime_type: string | null;
          period_start: string | null;
          period_end: string | null;
          amount_krw: number;
          amount_overridden: boolean;
          token_hash: string;
          token_issued_at: string;
          token_expires_at: string;
          token_revoked_at: string | null;
          status: "pending_participant" | "submitted_to_admin" | "claimed" | "paid";
          submitted_at: string | null;
          claimed_at: string | null;
          claimed_by: string | null;
          claimed_in: string | null;
          paid_at: string | null;
          paid_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          participant_id: string;
          experiment_id: string;
          booking_group_id: string;
          rrn_cipher?: string | null;
          rrn_iv?: string | null;
          rrn_tag?: string | null;
          rrn_key_version?: number;
          bank_name?: string | null;
          account_number?: string | null;
          account_holder?: string | null;
          institution?: string | null;
          name_override?: string | null;
          email_override?: string | null;
          phone?: string | null;
          payment_link_sent_at?: string | null;
          payment_link_attempts?: number;
          payment_link_last_error?: string | null;
          payment_link_last_attempt_at?: string | null;
          token_cipher?: string | null;
          token_iv?: string | null;
          token_tag?: string | null;
          token_key_version?: number | null;
          payment_link_first_opened_at?: string | null;
          payment_link_dispatch_lock_until?: string | null;
          signature_path?: string | null;
          signed_at?: string | null;
          bankbook_path?: string | null;
          bankbook_mime_type?: string | null;
          period_start?: string | null;
          period_end?: string | null;
          amount_krw?: number;
          amount_overridden?: boolean;
          token_hash: string;
          token_issued_at?: string;
          token_expires_at: string;
          token_revoked_at?: string | null;
          status?: "pending_participant" | "submitted_to_admin" | "claimed" | "paid";
          submitted_at?: string | null;
          claimed_at?: string | null;
          claimed_by?: string | null;
          claimed_in?: string | null;
          paid_at?: string | null;
          paid_by?: string | null;
        };
        Update: {
          rrn_cipher?: string | null;
          rrn_iv?: string | null;
          rrn_tag?: string | null;
          rrn_key_version?: number;
          bank_name?: string | null;
          account_number?: string | null;
          account_holder?: string | null;
          institution?: string | null;
          name_override?: string | null;
          email_override?: string | null;
          phone?: string | null;
          payment_link_sent_at?: string | null;
          payment_link_attempts?: number;
          payment_link_last_error?: string | null;
          payment_link_last_attempt_at?: string | null;
          token_cipher?: string | null;
          token_iv?: string | null;
          token_tag?: string | null;
          token_key_version?: number | null;
          payment_link_first_opened_at?: string | null;
          payment_link_dispatch_lock_until?: string | null;
          signature_path?: string | null;
          signed_at?: string | null;
          bankbook_path?: string | null;
          bankbook_mime_type?: string | null;
          period_start?: string | null;
          period_end?: string | null;
          amount_krw?: number;
          amount_overridden?: boolean;
          token_hash?: string;
          token_issued_at?: string;
          token_expires_at?: string;
          token_revoked_at?: string | null;
          status?: "pending_participant" | "submitted_to_admin" | "claimed" | "paid";
          submitted_at?: string | null;
          claimed_at?: string | null;
          claimed_by?: string | null;
          claimed_in?: string | null;
          paid_at?: string | null;
          paid_by?: string | null;
        };
        Relationships: [];
      };
      payment_claims: {
        Row: {
          id: string;
          experiment_id: string;
          claimed_by: string | null;
          claimed_at: string;
          booking_group_ids: string[];
          participant_count: number;
          total_krw: number;
          file_name: string | null;
          notes: string | null;
        };
        Insert: {
          id?: string;
          experiment_id: string;
          claimed_by?: string | null;
          claimed_at?: string;
          booking_group_ids?: string[];
          participant_count?: number;
          total_krw?: number;
          file_name?: string | null;
          notes?: string | null;
        };
        // Claim rows are back-filled with final counts + file name after the
        // ZIP is built, so we need a narrow Update shape.
        Update: {
          booking_group_ids?: string[];
          participant_count?: number;
          total_krw?: number;
          file_name?: string | null;
          notes?: string | null;
        };
        Relationships: [];
      };
      payment_exports: {
        Row: {
          id: string;
          experiment_id: string;
          exported_by: string | null;
          export_kind: "individual_form" | "upload_form" | "both" | "claim_bundle";
          participant_count: number;
          participant_ids: string[];
          file_name: string | null;
          exported_at: string;
        };
        Insert: {
          id?: string;
          experiment_id: string;
          exported_by?: string | null;
          export_kind: "individual_form" | "upload_form" | "both" | "claim_bundle";
          participant_count?: number;
          participant_ids?: string[];
          file_name?: string | null;
        };
        Update: never;
        Relationships: [];
      };
      labs: {
        Row: {
          id: string;
          code: string;
          name: string;
          // `participant_id_salt` is bytea — surfaced as a hex / base64 string
          // by PostgREST; treat as opaque from the TS side.
          participant_id_salt: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          code: string;
          name: string;
          participant_id_salt?: string;
          created_at?: string;
        };
        Update: {
          code?: string;
          name?: string;
          participant_id_salt?: string;
        };
        Relationships: [];
      };
      participant_lab_identity: {
        Row: {
          participant_id: string;
          lab_id: string;
          public_code: string;
          identity_hmac: string;
          created_at: string;
        };
        Insert: {
          participant_id: string;
          lab_id: string;
          public_code: string;
          identity_hmac: string;
          created_at?: string;
        };
        Update: {
          public_code?: string;
          identity_hmac?: string;
        };
        Relationships: [
          {
            foreignKeyName: "participant_lab_identity_participant_id_fkey";
            columns: ["participant_id"];
            isOneToOne: false;
            referencedRelation: "participants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "participant_lab_identity_lab_id_fkey";
            columns: ["lab_id"];
            isOneToOne: false;
            referencedRelation: "labs";
            referencedColumns: ["id"];
          },
        ];
      };
      participant_classes: {
        Row: {
          id: string;
          participant_id: string;
          lab_id: string;
          class: ParticipantClass;
          reason: string | null;
          assigned_by: string | null;
          assigned_kind: "auto" | "manual";
          completed_count: number;
          valid_from: string;
          valid_until: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          participant_id: string;
          lab_id: string;
          class: ParticipantClass;
          reason?: string | null;
          assigned_by?: string | null;
          assigned_kind?: "auto" | "manual";
          completed_count?: number;
          valid_from?: string;
          valid_until?: string | null;
          created_at?: string;
        };
        Update: {
          class?: ParticipantClass;
          reason?: string | null;
          assigned_by?: string | null;
          assigned_kind?: "auto" | "manual";
          completed_count?: number;
          valid_from?: string;
          valid_until?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "participant_classes_participant_id_fkey";
            columns: ["participant_id"];
            isOneToOne: false;
            referencedRelation: "participants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "participant_classes_lab_id_fkey";
            columns: ["lab_id"];
            isOneToOne: false;
            referencedRelation: "labs";
            referencedColumns: ["id"];
          },
        ];
      };
      booking_observations: {
        Row: {
          booking_id: string;
          pre_survey_done: boolean;
          pre_survey_info: string | null;
          post_survey_done: boolean;
          post_survey_info: string | null;
          notable_observations: string | null;
          researcher_id: string | null;
          entered_at: string;
          updated_at: string | null;
          notion_page_id: string | null;
          notion_synced_at: string | null;
        };
        Insert: {
          booking_id: string;
          pre_survey_done?: boolean;
          pre_survey_info?: string | null;
          post_survey_done?: boolean;
          post_survey_info?: string | null;
          notable_observations?: string | null;
          researcher_id?: string | null;
          entered_at?: string;
          updated_at?: string | null;
          notion_page_id?: string | null;
          notion_synced_at?: string | null;
        };
        Update: {
          pre_survey_done?: boolean;
          pre_survey_info?: string | null;
          post_survey_done?: boolean;
          post_survey_info?: string | null;
          notable_observations?: string | null;
          researcher_id?: string | null;
          notion_page_id?: string | null;
          notion_synced_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "booking_observations_booking_id_fkey";
            columns: ["booking_id"];
            isOneToOne: true;
            referencedRelation: "bookings";
            referencedColumns: ["id"];
          },
        ];
      };
      notification_log: {
        Row: {
          id: string;
          booking_id: string | null;
          channel: string;
          type: string;
          recipient: string;
          status: string;
          external_id: string | null;
          error_message: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          booking_id?: string | null;
          channel: string;
          type: string;
          recipient: string;
          status: string;
          external_id?: string | null;
          error_message?: string | null;
        };
        Update: {
          status?: string;
          external_id?: string | null;
          error_message?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "notification_log_booking_id_fkey";
            columns: ["booking_id"];
            isOneToOne: false;
            referencedRelation: "bookings";
            referencedColumns: ["id"];
          },
        ];
      };
      notion_health_state: {
        Row: {
          id: string;
          check_type: "schema_drift" | "retry_sweep" | "outbox_retry_sweep";
          healthy: boolean;
          schema_hash: string | null;
          report: Json;
          duration_ms: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          check_type: "schema_drift" | "retry_sweep" | "outbox_retry_sweep";
          healthy: boolean;
          schema_hash?: string | null;
          report?: Json;
          duration_ms?: number | null;
          created_at?: string;
        };
        Update: {
          healthy?: boolean;
          schema_hash?: string | null;
          report?: Json;
          duration_ms?: number | null;
        };
        Relationships: [];
      };
      class_promotion_notifications: {
        Row: {
          id: string;
          audit_id: string;
          researcher_user_id: string;
          sent_at: string;
          email_to: string;
          error_message: string | null;
        };
        Insert: {
          id?: string;
          audit_id: string;
          researcher_user_id: string;
          sent_at?: string;
          email_to: string;
          error_message?: string | null;
        };
        Update: {
          sent_at?: string;
          error_message?: string | null;
        };
        Relationships: [];
      };
      // Migration 00048. Rate-limit + audit log for the weekly
      // metadata-reminder cron (/api/cron/metadata-reminders).
      metadata_reminder_log: {
        Row: {
          id: string;
          researcher_user_id: string;
          sent_at: string;
          email_to: string;
          experiment_count: number;
          gap_summary: Json;
        };
        Insert: {
          id?: string;
          researcher_user_id: string;
          sent_at?: string;
          email_to: string;
          experiment_count: number;
          gap_summary: Json;
        };
        Update: {
          sent_at?: string;
          email_to?: string;
          experiment_count?: number;
          gap_summary?: Json;
        };
        Relationships: [];
      };
    };
    Views: {
      notion_health_current: {
        Row: {
          id: string;
          check_type: "schema_drift" | "retry_sweep" | "outbox_retry_sweep";
          healthy: boolean;
          schema_hash: string | null;
          report: Json;
          duration_ms: number | null;
          created_at: string;
        };
        Relationships: [];
      };
      participant_class_current: {
        Row: {
          id: string;
          participant_id: string;
          lab_id: string;
          class: ParticipantClass;
          reason: string | null;
          assigned_by: string | null;
          assigned_kind: "auto" | "manual";
          completed_count: number;
          valid_from: string;
          valid_until: string | null;
          created_at: string;
        };
        Relationships: [
          {
            foreignKeyName: "participant_classes_participant_id_fkey";
            columns: ["participant_id"];
            isOneToOne: false;
            referencedRelation: "participants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "participant_classes_lab_id_fkey";
            columns: ["lab_id"];
            isOneToOne: false;
            referencedRelation: "labs";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      book_slot: {
        Args: {
          p_experiment_id: string;
          p_participant_name: string;
          p_participant_phone: string;
          p_participant_email: string;
          p_participant_gender: string;
          p_participant_birthdate: string;
          p_slots: Json;
        };
        Returns: Json;
      };
      rpc_ingest_block: {
        Args: {
          p_booking_id: string;
          p_block_index: number;
        };
        Returns: Json;
      };
      rpc_rollback_block: {
        Args: {
          p_booking_id: string;
          p_expected_blocks: number;
        };
        Returns: Json;
      };
      rpc_mint_completion_code: {
        Args: {
          p_booking_id: string;
          p_code: string;
        };
        Returns: Json;
      };
      rpc_assign_condition: {
        Args: {
          p_booking_id: string;
        };
        Returns: string | null;
      };
      rpc_record_attention_failure: {
        Args: {
          p_booking_id: string;
          p_delta?: number;
        };
        Returns: number;
      };
      rpc_merge_behavior_signals: {
        Args: {
          p_booking_id: string;
          p_delta: Json;
        };
        Returns: Json;
      };
      recompute_participant_class: {
        Args: {
          p_participant_id: string;
          p_lab_id: string;
        };
        Returns: ParticipantClass;
      };
      submit_booking_observation: {
        Args: {
          p_booking_id: string;
          p_observation: Json;
        };
        Returns: Json;
      };
      auto_complete_stale_bookings: {
        Args: {
          p_grace_days?: number;
        };
        Returns: number;
      };
      assign_participant_class_manual: {
        Args: {
          p_participant_id: string;
          p_lab_id: string;
          p_class: ParticipantClass;
          p_reason: string | null;
          p_valid_until: string | null;
          p_assigned_by: string | null;
        };
        Returns: ParticipantClassRow;
      };
      claim_next_notion_retry: {
        Args: Record<string, never>;
        Returns: Array<{
          id: string;
          booking_id: string;
          integration_type:
            | "gcal"
            | "notion"
            | "email"
            | "sms"
            | "notion_experiment"
            | "notion_survey"
            | "status_email"
            | "status_sms";
          status: "pending" | "completed" | "failed" | "skipped";
          attempts: number;
          last_error: string | null;
          external_id: string | null;
          created_at: string;
          processed_at: string | null;
        }>;
      };
      finalize_notion_retry: {
        Args: {
          p_integration_id: string;
          p_status: "completed" | "failed" | "skipped";
          p_external_id: string | null;
          p_last_error: string | null;
        };
        Returns: void;
      };
      // Migration 00037 — generic version. `p_types` is the integration_type
      // filter array (e.g. ['notion', 'notion_survey', 'gcal', 'sms']).
      claim_next_outbox_retry: {
        Args: {
          p_types: Array<
            | "gcal"
            | "notion"
            | "email"
            | "sms"
            | "notion_experiment"
            | "notion_survey"
          >;
        };
        Returns: Array<{
          id: string;
          booking_id: string;
          integration_type:
            | "gcal"
            | "notion"
            | "email"
            | "sms"
            | "notion_experiment"
            | "notion_survey"
            | "status_email"
            | "status_sms";
          status: "pending" | "completed" | "failed" | "skipped";
          attempts: number;
          last_error: string | null;
          external_id: string | null;
          created_at: string;
          processed_at: string | null;
        }>;
      };
      finalize_outbox_retry: {
        Args: {
          p_integration_id: string;
          p_status: "completed" | "failed" | "skipped";
          p_external_id: string | null;
          p_last_error: string | null;
        };
        Returns: void;
      };
      pending_promotion_notifications: {
        Args: Record<string, never>;
        Returns: Array<{
          audit_id: string;
          participant_id: string;
          lab_id: string;
          lab_code: string | null;
          new_class: "newbie" | "royal" | "blacklist" | "vip";
          previous_class: "newbie" | "royal" | "blacklist" | "vip" | null;
          audit_created_at: string;
          researcher_user_id: string;
          researcher_contact_email: string | null;
          researcher_display_name: string | null;
          public_code: string | null;
        }>;
      };
      get_researcher_pending_work: {
        // D2-1 hardening (migration 00035): arg removed, function now
        // uses auth.uid() internally. EXECUTE restricted to authenticated.
        Args: Record<string, never>;
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}

// Convenience type aliases
export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type UserRole = Profile["role"];
export type RegistrationRequest = Database["public"]["Tables"]["registration_requests"]["Row"];
export type Experiment = Database["public"]["Tables"]["experiments"]["Row"];
export type ExperimentInsert = Database["public"]["Tables"]["experiments"]["Insert"];
export type Participant = Database["public"]["Tables"]["participants"]["Row"];
export type Booking = Database["public"]["Tables"]["bookings"]["Row"];
export type Reminder = Database["public"]["Tables"]["reminders"]["Row"];
export type ExperimentLocation = Database["public"]["Tables"]["experiment_locations"]["Row"];
export type ParticipantPaymentInfo = Database["public"]["Tables"]["participant_payment_info"]["Row"];
export type PaymentStatus = ParticipantPaymentInfo["status"];
export type PaymentExport = Database["public"]["Tables"]["payment_exports"]["Row"];
export type PaymentClaim = Database["public"]["Tables"]["payment_claims"]["Row"];
export type ExperimentManualBlock = Database["public"]["Tables"]["experiment_manual_blocks"]["Row"];
export type Labs = Database["public"]["Tables"]["labs"]["Row"];
export type Lab = Labs;
export type ParticipantLabIdentity = Database["public"]["Tables"]["participant_lab_identity"]["Row"];
export type ParticipantClasses = Database["public"]["Tables"]["participant_classes"]["Row"];
export type ParticipantClassRow = ParticipantClasses;
export type BookingObservation = Database["public"]["Tables"]["booking_observations"]["Row"];
