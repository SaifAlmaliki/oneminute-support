import { db } from "@/db/client";
import { teamMembers } from "@/db/schema";
import { isAuthorized } from "@/lib/isAuthorized";
import scalekit from "@/lib/scalekit";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const LoggedInUser = await isAuthorized();
    if (!LoggedInUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { email, name } = await req.json();

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const pendingTeamMember = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.user_email, email));

    if (pendingTeamMember.length > 0) {
      return NextResponse.json(
        { error: "User is already invited" },
        { status: 400 }
      );
    }

    const { user } = await scalekit.user.createUserAndMembership(
      LoggedInUser.organization_id,
      {
        email,
        userProfile: {
          firstName: name || email.split("@")[0],
          lastName: "",
        },
        sendInvitationEmail: true,
      }
    );

    await db.insert(teamMembers).values({
      user_email: email,
      name: name || email.split("@")[0],
      organization_id: LoggedInUser.organization_id,
    });

    return NextResponse.json({ user });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to add team member" },
      { status: 500 }
    );
  }
}
