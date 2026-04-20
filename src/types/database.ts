// This file should be regenerated with: npx supabase gen types typescript
// For now, manually define the types matching our schema.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

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
        };
        Update: {
          email?: string;
          display_name?: string | null;
          role?: "admin" | "researcher";
          disabled?: boolean;
          phone?: string;
          contact_email?: string;
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
          integration_type: "gcal" | "notion" | "email" | "sms";
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
          integration_type: "gcal" | "notion" | "email" | "sms";
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
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
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
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
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
          status: "confirmed" | "cancelled" | "completed" | "no_show";
          google_event_id: string | null;
          notion_page_id: string | null;
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
          status?: "confirmed" | "cancelled" | "completed" | "no_show";
          google_event_id?: string | null;
          notion_page_id?: string | null;
        };
        Update: {
          slot_start?: string;
          slot_end?: string;
          session_number?: number;
          subject_number?: number | null;
          status?: "confirmed" | "cancelled" | "completed" | "no_show";
          google_event_id?: string | null;
          notion_page_id?: string | null;
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
    };
    Views: {
      [_ in never]: never;
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
export type ExperimentManualBlock = Database["public"]["Tables"]["experiment_manual_blocks"]["Row"];
