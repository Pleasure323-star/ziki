import { Avatar } from "@/components/avatar";
import { VoterOverflowBadge } from "@/components/voter-overflow-badge";
import {
  formatOverflowCount,
  getOverflowVoters,
  VISIBLE_VOTERS,
  type VoterInfo,
} from "@/lib/voters";

type VoterAvatarsProps = {
  voters: VoterInfo[];
  totalCount: number;
  size?: "sm" | "md";
  className?: string;
};

function SingleAvatar({
  voter,
  size,
}: {
  voter: VoterInfo;
  size: "sm" | "md";
}) {
  // The group's own label gives the count; each face is decorative, with the
  // name on hover for sighted users (#290).
  return (
    <span title={voter.name} className="inline-flex rounded-full ring-card ring-2">
      <Avatar name={voter.name} image={voter.image} size={size === "sm" ? "xs" : "sm"} />
    </span>
  );
}

export function VoterAvatars({
  voters,
  totalCount,
  size = "sm",
  className = "",
}: VoterAvatarsProps) {
  if (totalCount === 0 || !voters || voters.length === 0) {
    return null;
  }

  const isSm = size === "sm";
  const visibleVoters = voters.slice(0, VISIBLE_VOTERS);
  const overflow = formatOverflowCount(totalCount, VISIBLE_VOTERS);
  const hidden = getOverflowVoters(voters, totalCount);

  return (
    <div
      className={`inline-flex items-center ${
        isSm ? "-space-x-1.5" : "-space-x-2"
      } ${className}`}
      aria-label={`${totalCount} ${totalCount === 1 ? "person" : "people"} marked this important`}
    >
      {visibleVoters.map((voter) => (
        <SingleAvatar key={voter.id} voter={voter} size={size} />
      ))}
      {overflow && hidden ? (
        <VoterOverflowBadge label={overflow} overflow={hidden} size={size} />
      ) : null}
    </div>
  );
}
