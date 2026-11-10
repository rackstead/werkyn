import { Suspense, useState, useEffect, useRef, useMemo } from "react";
import type { UpdateUserInput } from "@pm/shared";
import { toast } from "sonner";
import { Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserAvatar } from "@/components/shared/user-avatar";
import { useParams } from "@tanstack/react-router";
import { useAuthStore } from "@/stores/auth-store";
import { identityGeneration } from "@/lib/identity";
import { useProfile, useUpdateProfile, useChangePassword } from "../api";
import { useUploadFile } from "@/features/uploads/api";
import { AvatarCropDialog } from "@/components/shared/avatar-crop-dialog.lazy";
import { AVATAR_ACCEPT, avatarFileProblem } from "@/components/shared/avatar-crop";

const TIMEZONE_NONE = "__none__";

type ProfileFields = {
  displayName: string;
  jobTitle: string;
  phone: string;
  timezone: string;
};

export function ProfileSettings() {
  const { workspaceSlug } = useParams({ strict: false }) as { workspaceSlug?: string };
  const workspaces = useAuthStore((s) => s.workspaces);
  const profileUserId = useAuthStore((s) => s.user?.id);
  const profileGeneration = identityGeneration();
  const workspaceId = workspaceSlug
    ? workspaces.find((w) => w.workspace.slug === workspaceSlug)?.workspace.id
    : undefined;

  const { data: profile, isLoading } = useProfile();
  const updateProfile = useUpdateProfile();
  const changePassword = useChangePassword();
  const uploadFile = useUploadFile();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [profileDraft, setProfileDraft] = useState<{
    source: NonNullable<typeof profile>;
    generation: number;
    initial: ProfileFields;
    values: ProfileFields;
  } | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarWorkspaceId, setAvatarWorkspaceId] = useState<string | null>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const avatarSavingRef = useRef(false);

  const timezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Tokyo"];
    }
  }, []);

  useEffect(() => {
    if (
      !profile || profile.id !== profileUserId ||
      profileGeneration !== identityGeneration() ||
      profileUserId !== useAuthStore.getState().user?.id
    ) {
      setProfileDraft(null);
      return;
    }
    const initial = {
      displayName: profile.displayName,
      jobTitle: profile.jobTitle ?? "",
      phone: profile.phone ?? "",
      timezone: profile.timezone ?? "",
    };
    setProfileDraft({
      source: profile,
      generation: profileGeneration,
      initial,
      values: initial,
    });
  }, [profile, profileUserId, profileGeneration]);

  useEffect(() => {
    if (!avatarFile || avatarSavingRef.current) return;
    if (avatarWorkspaceId !== workspaceId) {
      setAvatarFile(null);
      setAvatarWorkspaceId(null);
    }
  }, [workspaceId, avatarFile, avatarWorkspaceId, avatarSaving]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!profile || profile.id !== profileUserId) return null;

  const profileReady = profileDraft !== null && profileDraft.source === profile &&
    profileDraft.generation === profileGeneration;
  const fields = profileReady ? profileDraft.values : {
    displayName: profile.displayName,
    jobTitle: profile.jobTitle ?? "",
    phone: profile.phone ?? "",
    timezone: profile.timezone ?? "",
  };

  function setProfileField(field: keyof ProfileFields, value: string) {
    setProfileDraft((current) => {
      if (
        !current || current.source !== profile ||
        current.generation !== identityGeneration() ||
        current.source.id !== useAuthStore.getState().user?.id
      ) return current;
      return { ...current, values: { ...current.values, [field]: value } };
    });
  }

  function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !workspaceId) return;
    const problem = avatarFileProblem(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    setAvatarFile(file);
    setAvatarWorkspaceId(workspaceId);
  }

  function stopAvatarSaving() {
    avatarSavingRef.current = false;
    setAvatarSaving(false);
  }

  function dismissAvatar() {
    if (avatarSavingRef.current) return;
    setAvatarFile(null);
    setAvatarWorkspaceId(null);
  }

  function saveAvatar(cropped: File) {
    const targetWorkspaceId = avatarWorkspaceId;
    if (!targetWorkspaceId || avatarSavingRef.current) return;
    avatarSavingRef.current = true;
    setAvatarSaving(true);
    uploadFile.mutate(
      { file: cropped, purpose: "avatar", workspaceId: targetWorkspaceId },
      {
        onSuccess: (res: { data: { url: string } }) => {
          updateProfile.mutate(
            { avatarUrl: res.data.url },
            {
              onSuccess: () => {
                toast.success("Avatar updated");
                setAvatarFile(null);
                setAvatarWorkspaceId(null);
                stopAvatarSaving();
              },
              onError: () => stopAvatarSaving(),
            },
          );
        },
        onError: (err: Error) => {
          toast.error(err.message);
          stopAvatarSaving();
        },
      },
    );
  }

  function handleRemoveAvatar() {
    updateProfile.mutate(
      { avatarUrl: null },
      { onSuccess: () => toast.success("Avatar removed") },
    );
  }

  function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (
      !profileDraft || profileDraft.source !== profile ||
      profileDraft.generation !== identityGeneration() ||
      profileDraft.source.id !== useAuthStore.getState().user?.id
    ) return;

    const { values, initial } = profileDraft;
    const data: UpdateUserInput = {};
    if (values.displayName !== initial.displayName) {
      if (!values.displayName.trim()) {
        toast.error("Display name is required");
        return;
      }
      data.displayName = values.displayName.trim();
    }
    if (values.jobTitle !== initial.jobTitle) data.jobTitle = values.jobTitle.trim() || null;
    if (values.phone !== initial.phone) data.phone = values.phone.trim() || null;
    if (values.timezone !== initial.timezone) data.timezone = values.timezone || null;
    if (Object.keys(data).length === 0) return;

    updateProfile.mutate(data, {
      onSuccess: (updatedUser) => {
        setProfileDraft((current) => {
          if (
            !current || current.source !== profileDraft.source ||
            current.generation !== profileDraft.generation ||
            current.generation !== identityGeneration() ||
            current.source.id !== useAuthStore.getState().user?.id
          ) return current;
          // Equal canonical data can retain the same query object on success.
          return {
            ...current,
            initial: {
              displayName: current.values.displayName === values.displayName ? values.displayName : updatedUser.displayName,
              jobTitle: current.values.jobTitle === values.jobTitle ? values.jobTitle : updatedUser.jobTitle ?? "",
              phone: current.values.phone === values.phone ? values.phone : updatedUser.phone ?? "",
              timezone: current.values.timezone === values.timezone ? values.timezone : updatedUser.timezone ?? "",
            },
          };
        });
        toast.success("Profile updated");
      },
    });
  }

  function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPassword || !newPassword) {
      toast.error("Both password fields are required");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }

    changePassword.mutate(
      {
        userId: profile!.id,
        currentPassword,
        newPassword,
      },
      {
        onSuccess: () => {
          toast.success("Password changed successfully");
          setCurrentPassword("");
          setNewPassword("");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  const isUploading = uploadFile.isPending || avatarSaving;

  return (
    <div className="space-y-8">
      {/* Avatar Section */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Avatar</h2>
        <div className="flex items-center gap-4">
          <UserAvatar
            displayName={profile.displayName}
            avatarUrl={profile.avatarUrl}
            size="xl"
          />
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
              >
                {isUploading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Upload
              </Button>
              {profile.avatarUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRemoveAvatar}
                  disabled={updateProfile.isPending}
                >
                  <X className="mr-2 h-4 w-4" />
                  Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Recommended: Square image, at least 256x256px
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={AVATAR_ACCEPT}
            className="hidden"
            onChange={handleAvatarUpload}
          />
          {avatarFile && (
            <Suspense fallback={null}>
              <AvatarCropDialog
                file={avatarFile}
                saving={avatarSaving}
                onCancel={dismissAvatar}
                onConfirm={saveAvatar}
                onError={(message) => toast.error(message)}
              />
            </Suspense>
          )}
        </div>
      </section>

      {/* Profile Info Section */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Profile Information</h2>
        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="displayName">Display Name</Label>
            <Input
              id="displayName"
              value={fields.displayName}
              onChange={(e) => setProfileField("displayName", e.target.value)}
              disabled={!profileReady}
              required={profileReady && fields.displayName !== profileDraft.initial.displayName}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={profile.email} disabled />
          </div>

          <div className="space-y-2">
            <Label htmlFor="jobTitle">Job Title</Label>
            <Input
              id="jobTitle"
              value={fields.jobTitle}
              onChange={(e) => setProfileField("jobTitle", e.target.value)}
              disabled={!profileReady}
              placeholder="e.g. Senior Engineer"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              value={fields.phone}
              onChange={(e) => setProfileField("phone", e.target.value)}
              disabled={!profileReady}
              placeholder="e.g. +1 (555) 123-4567"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Select
              value={fields.timezone || TIMEZONE_NONE}
              onValueChange={(val) => setProfileField("timezone", val === TIMEZONE_NONE ? "" : val)}
              disabled={!profileReady}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select timezone" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TIMEZONE_NONE}>None</SelectItem>
                {timezones.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button type="submit" disabled={updateProfile.isPending || !profileReady}>
            {updateProfile.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Save Changes
          </Button>
        </form>
      </section>

      {/* Change Password Section */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Change Password</h2>
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="currentPassword">Current Password</Label>
            <Input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="newPassword">New Password</Label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>

          <Button
            type="submit"
            variant="outline"
            disabled={changePassword.isPending}
          >
            {changePassword.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Change Password
          </Button>
        </form>
      </section>
    </div>
  );
}
