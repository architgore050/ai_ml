from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("app", "0009_alter_user_revenuecat_app_user_id"),
    ]

    operations = [
        migrations.AddField(
            model_name="audioclip",
            name="transcript_text",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="audioclip",
            name="moderation_reason",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="audioclip",
            name="moderated_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="audioclip",
            name="moderated_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.SET_NULL,
                related_name="moderated_clips",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
