import { BookOpenText, ChevronRight, Shapes, Sigma } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { BOARD_PROFILES, type BoardProfile } from "@/app/board/boardProfiles";

type BoardProfilePickerProps = {
  onSelectProfile: (profile: BoardProfile) => void;
  onBack: () => void;
};

const ProfileIcon = ({ profile }: { profile: BoardProfile }) => {
  if (profile === "analytical") return <Sigma size={24} />;
  if (profile === "textual") return <BookOpenText size={24} />;
  return <Shapes size={24} />;
};

export default function BoardProfilePicker({ onSelectProfile, onBack }: BoardProfilePickerProps) {
  return (
    <main className="session-shell">
      <section className="w-full max-w-[1680px]">
        <div>
          <Button
            variant="ghost"
            onClick={onBack}
            className="h-10 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-[12px] text-frost/65 hover:bg-white/[0.06] hover:text-frost"
          >
            ← К предметам
          </Button>
        </div>

        <div className="mx-auto mt-10 w-full max-w-[1180px] lg:mt-14">
          <div className="mx-auto max-w-[720px] text-center">
            <div className="mb-4 flex items-center justify-center gap-2.5 text-[11px] font-semibold text-frost/35">
              <span className="h-1.5 w-12 rounded-full bg-accent" />
              <span className="h-1.5 w-12 rounded-full bg-accent" />
              <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/10">
                <motion.span
                  className="block h-full w-full origin-left rounded-full bg-accent"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1], delay: 0.12 }}
                />
              </span>
              <motion.span
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, delay: 0.2 }}
              >
                3 / 3
              </motion.span>
            </div>

            <h1 className="text-4xl font-bold tracking-[-0.035em] text-frost sm:text-5xl">Выберите доску</h1>
            <p className="mx-auto mt-3 max-w-[660px] text-sm leading-6 text-frost/50 sm:text-[15px]">
              Набор инструментов и разметка подстроятся под тип урока.
            </p>
          </div>

          <div className="mt-9 grid gap-4 md:grid-cols-3">
            {BOARD_PROFILES.map((profile) => (
              <button
                key={profile.id}
                type="button"
                aria-label={profile.name}
                onClick={() => onSelectProfile(profile.id)}
                className="session-board-profile group relative min-h-[290px] overflow-hidden rounded-[22px] p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <div className="flex items-start justify-between">
                  <span className="grid h-11 w-11 place-items-center rounded-[13px] border border-white/10 bg-white/[0.035] text-frost/70 transition group-hover:text-accent">
                    <ProfileIcon profile={profile.id} />
                  </span>
                  <ChevronRight size={18} className="translate-x-1 text-frost/25 opacity-0 transition group-hover:translate-x-0 group-hover:text-accent group-hover:opacity-100" />
                </div>

                <div className="mt-8">
                  <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-frost">{profile.name}</h2>
                  <p className="mt-2 max-w-[280px] text-[13px] leading-5 text-frost/48">{profile.description}</p>
                </div>

                <div className="mt-7 h-[64px] overflow-hidden rounded-[12px] border border-white/10 bg-white/[0.02]">
                  {profile.backgroundPattern === "grid" ? (
                    <div className="h-full w-full board-profile-grid" />
                  ) : (
                    <div className="h-full w-full board-profile-lines" />
                  )}
                </div>

                <div className="mt-4 text-[11px] font-medium text-frost/38">{profile.hint}</div>
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

